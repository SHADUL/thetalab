/**
 * The real-order orchestrator paperFill.ts's own header always said was a
 * separate, not-yet-built layer. Unlike paper mode (every leg fills
 * instantly, in whatever order the array happens to hold), this is where
 * order actually matters: Zerodha's margin engine only recognizes a
 * defined-risk hedge once it has SEEN the protective leg fill — a naked
 * SELL fired before its BUY demands full standalone margin (~10x more).
 * So every BUY (hedge) leg is placed and confirmed FILLED before any SELL
 * (short) leg is ever attempted, regardless of the order legs were
 * constructed in upstream (creditSpread.ts/ironCondor.ts build SELL-then-
 * BUY, which is fine for paper and irrelevant here — this module re-sorts).
 *
 * Reuses the SAME state machine and leg-failure engine paper mode's
 * caller already exercises (stateMachine.ts, legFailureHandler.ts) — this
 * file's only job is the part those modules explicitly say is out of
 * their scope: actually calling out to place/poll/unwind real orders,
 * via an injected `LiveOrderPlacer` so the sequencing logic itself can be
 * tested without a real Kite session or real money.
 */
import { afterProtectionConfirmed, beginMonitoring } from './stateMachine.ts';
import { decideLegFailureAction, deriveProtectionState } from './legFailureHandler.ts';
import type { ExecutionState, LegFillState, ProtectionState } from './types.ts';
import type { ValidationResult } from './preTradeValidation.ts';
import type { PlannedLeg, PaperFillResult } from './paperFill.ts';

export type TerminalOrderStatus = 'COMPLETE' | 'REJECTED' | 'CANCELLED' | 'TIMEOUT';

export interface LiveOrderPlacer {
  /** Places a single order at the given limit price. Returns Kite's order_id. Throws only on a request-level failure (network, bad params) — a broker-side rejection is a normal outcome, not an exception. */
  placeOrder(leg: PlannedLeg, exchange: string, transactionType: 'BUY' | 'SELL', limitPrice: number): Promise<string>;
  /** Polls until the order reaches a terminal state or timeoutMs elapses. averagePrice is populated only when status is COMPLETE. */
  awaitFill(orderId: string, timeoutMs: number): Promise<{ status: TerminalOrderStatus; averagePrice: number | null }>;
  /** A FRESH quote at execution time — never the stale quote the candidate was originally priced from. Null when the quote couldn't be fetched at all. */
  getQuote(tradingsymbol: string, exchange: string): Promise<{ bid: number; ask: number; lastPrice: number } | null>;
  /** Best-effort market order to flatten an already-filled leg during an unwind. Failures are caught by the caller, not thrown past it. */
  closeLeg(leg: PlannedLeg, exchange: string): Promise<string>;
}

export interface LiveFillOptions {
  exchange: string;
  /** Passed straight through to decideLegFailureAction — same default (2) it already uses. */
  maxRetries?: number;
  /** Per-order fill-wait budget. Keep this well under the calling Vercel function's own maxDuration — see api/options-autotrade.ts's handlePaperScan for the overall time budget this has to fit inside alongside chain-fetch and decisioning. */
  fillTimeoutMs?: number;
  /**
   * A live quote this far (as a fraction, e.g. 0.5 = 50%) from the leg's
   * originally-modeled fillPrice is treated as a bad/stale tick rather than
   * a real price move, and that leg's attempt is skipped this round — the
   * same reasoning as position-monitor's own impossible-cost-to-close
   * guard, applied before an order is placed instead of after a fill.
   */
  maxPriceDeviationFraction?: number;
}

const DEFAULTS = { maxRetries: 2, fillTimeoutMs: 15_000, maxPriceDeviationFraction: 0.5 };

function legKey(l: { side: string; right: string; strike: number }) {
  return `${l.side}:${l.right}:${l.strike}`;
}

/**
 * Runs ONE pass over `pending` legs (all BUYs before any SELL — the
 * caller guarantees this ordering), placing and awaiting each in turn.
 * Stops firing further legs the moment one doesn't reach COMPLETE, so a
 * failure never lets a later SELL leg jump ahead of an unfilled BUY.
 */
async function attemptPass(
  pending: PlannedLeg[],
  orders: LiveOrderPlacer,
  exchange: string,
  fillTimeoutMs: number,
  maxPriceDeviationFraction: number,
  log: string[],
  fills: Map<string, { orderId: string; avgPrice: number }>,
): Promise<LegFillState[]> {
  const results: LegFillState[] = [];
  let blocked = false;

  for (const leg of pending) {
    const key = legKey(leg);
    if (blocked) {
      results.push({ side: leg.side, right: leg.right, strike: leg.strike, status: 'PENDING' });
      continue;
    }

    const quote = await orders.getQuote(leg.tradingsymbol, exchange);
    if (!quote) {
      log.push(`${leg.side} ${leg.tradingsymbol}: no live quote available — skipped, not fired.`);
      results.push({ side: leg.side, right: leg.right, strike: leg.strike, status: 'REJECTED' });
      blocked = true;
      continue;
    }
    const referencePrice = leg.side === 'BUY' ? quote.ask : quote.bid;
    const deviation = leg.fillPrice > 0 ? Math.abs(referencePrice - leg.fillPrice) / leg.fillPrice : 0;
    if (deviation > maxPriceDeviationFraction) {
      log.push(`${leg.side} ${leg.tradingsymbol}: live quote (₹${referencePrice.toFixed(2)}) is ${(deviation * 100).toFixed(0)}% off the modeled price (₹${leg.fillPrice.toFixed(2)}) — treated as a bad/stale tick, not fired.`);
      results.push({ side: leg.side, right: leg.right, strike: leg.strike, status: 'REJECTED' });
      blocked = true;
      continue;
    }

    let orderId: string;
    try {
      orderId = await orders.placeOrder(leg, exchange, leg.side, referencePrice);
    } catch (err: any) {
      log.push(`${leg.side} ${leg.tradingsymbol}: order placement request failed — ${err.message}`);
      results.push({ side: leg.side, right: leg.right, strike: leg.strike, status: 'REJECTED' });
      blocked = true;
      continue;
    }

    const outcome = await orders.awaitFill(orderId, fillTimeoutMs);
    if (outcome.status === 'COMPLETE' && outcome.averagePrice != null) {
      fills.set(key, { orderId, avgPrice: outcome.averagePrice });
      log.push(`${leg.side} ${leg.tradingsymbol}: FILLED at ₹${outcome.averagePrice.toFixed(2)} (order ${orderId}).`);
      results.push({ side: leg.side, right: leg.right, strike: leg.strike, status: 'FILLED' });
    } else {
      log.push(`${leg.side} ${leg.tradingsymbol}: order ${orderId} ended ${outcome.status} — not filled.`);
      results.push({ side: leg.side, right: leg.right, strike: leg.strike, status: outcome.status === 'CANCELLED' ? 'CANCELLED' : 'REJECTED' });
      blocked = true;
    }
  }

  return results;
}

export async function runLiveExecution(
  legs: PlannedLeg[],
  validation: ValidationResult,
  orders: LiveOrderPlacer,
  opts: LiveFillOptions,
): Promise<PaperFillResult & { attempts: number }> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const fillTimeoutMs = opts.fillTimeoutMs ?? DEFAULTS.fillTimeoutMs;
  const maxPriceDeviationFraction = opts.maxPriceDeviationFraction ?? DEFAULTS.maxPriceDeviationFraction;
  const log: string[] = [];

  if (!validation.passed) {
    const failedDetail = validation.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join(' | ');
    log.push(`VALIDATING -> FAILED: ${failedDetail}`);
    return {
      state: 'FAILED',
      legFills: legs.map((l) => ({ ...l, status: 'REJECTED' })),
      protection: 'NONE',
      log,
      attempts: 0,
    };
  }
  log.push('VALIDATING -> SUBMITTING: all pre-trade checks passed. Real orders will now be placed — BUY (hedge) legs first, SELL (short) legs only after every BUY leg confirms FILLED.');

  const fills = new Map<string, { orderId: string; avgPrice: number }>();
  let legStates: LegFillState[] = legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, status: 'PENDING' }));
  let attempts = 0;

  for (;;) {
    const filledKeys = new Set(legStates.filter((l) => l.status === 'FILLED').map(legKey));
    const remaining = legs.filter((l) => !filledKeys.has(legKey(l)));
    // BUY-before-SELL, preserved across retries: unfilled BUY legs always
    // come before unfilled SELL legs in this list, so a retry can never
    // fire a short ahead of its still-pending hedge.
    const ordered = [...remaining.filter((l) => l.side === 'BUY'), ...remaining.filter((l) => l.side === 'SELL')];

    const passResults = await attemptPass(ordered, orders, opts.exchange, fillTimeoutMs, maxPriceDeviationFraction, log, fills);
    const passByKey = new Map(passResults.map((r) => [legKey(r), r]));
    legStates = legs.map((l) => {
      const key = legKey(l);
      if (filledKeys.has(key)) return legStates.find((s) => legKey(s) === key)!;
      return passByKey.get(key) ?? { side: l.side, right: l.right, strike: l.strike, status: 'PENDING' as const };
    });

    const decision = decideLegFailureAction(legStates, attempts, maxRetries);
    attempts++;

    if (decision.action === 'NONE_NEEDED') {
      const protection = deriveProtectionState(legStates);
      if (protection === 'FULL') {
        log.push(`SUBMITTING -> FILLED: every leg confirmed filled by the broker.`);
        const protectedState = afterProtectionConfirmed('FILLED' as ExecutionState);
        log.push(`FILLED -> ${protectedState}: structure complete, protection FULL.`);
        const activeState = beginMonitoring();
        log.push(`${protectedState} -> ${activeState}: handed off to position monitoring.`);
        const legFills = legs.map((l) => {
          const fill = fills.get(legKey(l))!;
          return { ...l, fillPrice: fill.avgPrice, status: 'FILLED' as const, orderId: fill.orderId };
        });
        return { state: activeState, legFills, protection, log, attempts };
      }
      // Nothing filled at all — a clean failed attempt, nothing to unwind.
      log.push('SUBMITTING -> FAILED: no leg filled — nothing to unwind.');
      return { state: 'FAILED', legFills: legs.map((l) => ({ ...l, status: 'REJECTED' as const })), protection: 'NONE', log, attempts };
    }

    if (decision.action === 'RETRY_REMAINING') {
      log.push(`Retrying: ${decision.reason}`);
      continue;
    }

    // CLOSE_FILLED_LEGS: an incomplete structure after exhausting retries.
    // Every filled leg gets a best-effort market order to flatten it —
    // this is the single most dangerous path (a naked short may be
    // unwound late), so every outcome is logged loudly regardless of
    // success, for a human to verify against the broker directly.
    log.push(`SUBMITTING -> unwinding: ${decision.reason}`);
    for (const closeLeg of decision.legsToClose) {
      const plannedLeg = legs.find((l) => legKey(l) === legKey(closeLeg));
      if (!plannedLeg) continue;
      try {
        const closeOrderId = await orders.closeLeg(plannedLeg, opts.exchange);
        log.push(`UNWIND: placed closing order ${closeOrderId} for ${plannedLeg.side} ${plannedLeg.tradingsymbol} — verify fill against the broker directly.`);
      } catch (err: any) {
        log.push(`UNWIND FAILED for ${plannedLeg.side} ${plannedLeg.tradingsymbol}: ${err.message} — THIS LEG MAY STILL BE OPEN AT THE BROKER. Manual check required immediately.`);
      }
    }
    const legFills = legs.map((l) => {
      const fill = fills.get(legKey(l));
      return fill
        ? { ...l, fillPrice: fill.avgPrice, status: 'CANCELLED' as const, orderId: fill.orderId }
        : { ...l, status: 'REJECTED' as const };
    });
    return { state: 'FAILED', legFills, protection: 'NONE' as ProtectionState, log, attempts };
  }
}
