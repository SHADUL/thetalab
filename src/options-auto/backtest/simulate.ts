/**
 * Walks a symbol's historical bhavcopy day-by-day through the EXACT
 * production decision pipeline (normalise -> enrichChain -> evaluateExpiries
 * -> decideTrade) and the EXACT production exit engine (evaluateExit) —
 * no reimplementation, same discipline as src/swing's and src/intraday's
 * own backtests reusing their live scanner/exit functions directly, so
 * there is no second "backtest version" of this logic to drift out of
 * sync with what's actually live.
 *
 * One position at a time, deliberately: this backtest doesn't attempt
 * concurrent-position capital allocation. That's a real, stated
 * simplification — but a deliberate one, because it's exactly what makes
 * a genuine chronological equity curve (and therefore real drawdown,
 * Sharpe/Sortino, Monte Carlo) honest to compute here, unlike swing's and
 * intraday's signal-level backtests, which explicitly cannot support
 * those metrics because they have no single coherent portfolio (see
 * src/swing/backtest/metrics.ts's and src/intraday/backtest/metrics.ts's
 * own stated reasoning for excluding them). See metrics.ts for that.
 *
 * Point-in-time discipline: signal generation at day i only ever sees
 * that day's own bhavcopy — the SAME data a live paper-scan on that
 * historical date would have seen (settlement/OI/volume, no bid/ask,
 * which is exactly what enrichChain() already treats as its baseline
 * case). Re-quoting an open position's legs on day i+1, i+2, ... is the
 * one place allowed to "look forward" relative to the entry day — the
 * same discipline swing's simulateTrade() and intraday's
 * simulateIntradayExit() already establish for their own one-place-only
 * forward look.
 */
import { normalise, type RawChainPayload } from '../../quant/data/adapter.ts';
import { enrichChain } from '../../quant/enrich.ts';
import { evaluateExpiries } from '../../quant/strategies/expirySelector.ts';
import { decideTrade, DEFAULT_DECISION_THRESHOLDS, classifyTradeQuality, type DecisionThresholds } from '../../quant/strategies/decisionGate.ts';
import { evaluateExit, DEFAULT_EXIT_PARAMS, type ShortStrike } from '../../quant/execution/exitEngine.ts';
import { computeRoundTripLegCharges, computeTradeCostBreakdown, type TradeCostBreakdown } from './costs.ts';
import type { HistoricalChainDay } from './bhavcopy.ts';
import type { HistoricalClose } from '../../quant/analytics/realizedVolatility.ts';
import { computePositionSize, DEFAULT_RISK_LIMITS, type PortfolioState, type OpenPositionSummary, type RiskLimits } from '../../quant/strategies/positionSizing.ts';
import { checkDailyRiskLock, type DailyRiskState } from '../../quant/execution/dailyRiskLock.ts';
import { simulateStructureFill, type FillMode, type LegQuote, type SimulatedFill, type ExecutionDataQuality } from '../../quant/execution/fillSimulator.ts';
import { computePointInTimeIvRank, type IvHistoryPoint } from '../../quant/analytics/ivRankHistory.ts';
import { atmIvOf } from '../../quant/analytics/atmIv.ts';

export interface SimulatedLeg {
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
  entryPrice: number;
  exitPrice: number | null;
}

export interface SimulatedTrade {
  symbol: string;
  strategyLabel: string;
  entryDate: string;
  exitDate: string | null;
  expiry: string;
  legs: SimulatedLeg[];
  qualityScore: number;
  entryDte: number;
  /** Per ONE lot (this backtest always sizes 1 lot — see header). */
  maxProfit: number;
  maxLoss: number;
  /** ExitReason from exitEngine.ts, or 'DATA_END' when the backtest window ran out before any real exit condition triggered — never counted as a genuine win/loss. */
  exitReason: string | null;
  /** (maxProfit - exitCostToClose), price-only, before charges. Null only for a DATA_END trade with no valid re-quote at all. */
  grossPnl: number | null;
  charges: number | null;
  netPnl: number | null;
}

export interface SimulateParams {
  wingWidths: number[];
  deltaTargets?: number[];
  minDte?: number;
  maxDte?: number;
  qualityThresholds?: DecisionThresholds;
  exitParams?: {
    profitTargetPct?: number;
    stopLossCreditMultiple?: number;
    timeExitDte?: number;
    strikeBreachBufferPct?: number;
  };
}

interface OpenTrade {
  strategyLabel: string;
  entryDate: string;
  expiry: string;
  legs: SimulatedLeg[];
  qualityScore: number;
  entryDte: number;
  maxProfit: number;
  maxLoss: number;
  lotSize: number;
}

function buildChainPayload(day: HistoricalChainDay, symbol: string): RawChainPayload | null {
  if (!day.spot || day.rows.length === 0) return null;
  const valuationTime = Date.parse(`${day.date}T15:30:00+05:30`);
  const step = inferStrikeStep([...new Set(day.rows.map((r) => r.strike))].sort((a, b) => a - b));
  return {
    source: { providerId: 'nse-bse-bhavcopy', kind: 'eod', retrievedAt: valuationTime },
    contract: {
      underlyingSymbol: symbol,
      lotSize: day.lotSize && day.lotSize > 0 ? day.lotSize : 1,
      pointValue: 1,
      strikeStep: step,
      currency: 'INR',
      exerciseStyle: 'european',
      pricingBasis: 'futures',
    },
    context: { valuationTime, spot: day.spot, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows: day.rows.map((r) => ({
      right: r.right, strike: r.strike, expiry: Date.parse(`${r.expiry}T15:30:00+05:30`), asOf: valuationTime,
      settle: r.settle, openInterest: r.openInterest, volume: r.volume,
    })),
  };
}

function inferStrikeStep(sortedStrikes: number[]): number {
  let step = Infinity;
  for (let i = 1; i < sortedStrikes.length; i++) step = Math.min(step, sortedStrikes[i] - sortedStrikes[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

function finalizeTrade(open: OpenTrade, symbol: string, exitDate: string, exitReason: string, currentCostToClose: number | null): SimulatedTrade {
  let grossPnl: number | null = null;
  let charges: number | null = null;
  let netPnl: number | null = null;

  // Only compute costs when every leg genuinely has a real exit price —
  // if even one is missing (a leg's quote wasn't found that day), the
  // whole trade's P&L is reported as unknown rather than partially
  // estimated from a mix of real and absent prices.
  const everyLegPriced = open.legs.every((l) => l.exitPrice !== null);
  if (currentCostToClose !== null && everyLegPriced) {
    grossPnl = open.maxProfit - currentCostToClose;
    charges = open.legs.reduce((sum, l) => {
      const entryTurnover = l.entryPrice * open.lotSize;
      const exitTurnover = l.exitPrice! * open.lotSize;
      return sum + computeRoundTripLegCharges(l.side, entryTurnover, exitTurnover);
    }, 0);
    netPnl = grossPnl - charges;
  }

  return {
    symbol, strategyLabel: open.strategyLabel, entryDate: open.entryDate, exitDate, expiry: open.expiry,
    legs: open.legs, qualityScore: open.qualityScore, entryDte: open.entryDte,
    maxProfit: open.maxProfit, maxLoss: open.maxLoss,
    exitReason, grossPnl, charges, netPnl,
  };
}

/* ==================================================================== *
 * simulateSymbolRealistic — QUANT_AUDIT.md Phase A/B/C additions.
 *
 * A SEPARATE, additive entry point from simulateSymbol() above (which is
 * UNCHANGED — same signature, same behavior, same 24 passing tests) so
 * none of the existing, already-verified backtest behavior is at risk.
 * Reuses every shared helper (buildChainPayload, inferStrikeStep,
 * evaluateExpiries, decideTrade, evaluateExit) rather than duplicating
 * any of that logic — only the entry-time data wiring, position sizing,
 * daily risk lock, and fill/cost modeling are new.
 * ==================================================================== */

export type MarginSource = 'LIVE_KITE' | 'HISTORICAL_MODEL' | 'UNAVAILABLE';

export interface DataQualityLabels {
  pricingData: 'EOD_SETTLEMENT';
  bidAsk: 'UNAVAILABLE';
  execution: 'EOD_APPROXIMATION' | 'LIVE_QUOTE';
  historicalIv: 'AVAILABLE' | 'UNAVAILABLE';
  margin: MarginSource;
  slippageConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface RealisticSimulateParams extends SimulateParams {
  /** Full real underlying close series (any date range) — sliced point-in-time (<= the current simulated day) before every use. Omit to keep premiumEdge/independentEv excluded, same as simulateSymbol(). */
  historicalCloses?: HistoricalClose[];
  /** Full real ATM-IV archive, same point-in-time discipline (see analytics/ivRankHistory.ts). Omit or empty -> ivRank always reported UNAVAILABLE, never fabricated. */
  ivHistory?: IvHistoryPoint[];
  /** Which fill model to simulate entry/exit prices with. Defaults to REALISTIC (the task's own stated default for new research runs). */
  fillMode?: FillMode;
  /** Starting capital for portfolio-aware position sizing (Phase 8). Required to enable sizing — omitted means every signal still trades exactly 1 lot (simulateSymbol()'s own behavior), clearly labeled in the output. */
  startingEquity?: number;
  /** Risk limits for computePositionSize — defaults to positionSizing.ts's own DEFAULT_RISK_LIMITS (the SAME numbers production uses), never a research-tuned value, per this phase's explicit "do not touch risk percentages" instruction. */
  riskLimits?: RiskLimits;
  /** Daily risk lock (Phase 9) — defaults to the SAME defaults options_autotrade_settings itself ships with (4% daily loss, 3 consecutive losses), not a research-tuned value. */
  dailyLock?: { maxDailyLossPct?: number; maxConsecutiveLosses?: number };
  /**
   * Operator-clearing policy (out-of-sample phase, Task 7) — production's
   * live daily lock NEVER auto-clears (a deliberate, unchanged safety
   * property — this param does not and cannot alter production behavior).
   * This is a BACKTEST-ONLY simulation of realistic operator behavior,
   * since an unattended multi-year backtest has no human to manually
   * clear a stuck lock the way a live operator would. Defaults to
   * NEVER_CLEAR, i.e. IDENTICAL to this function's own pre-existing
   * behavior when this param is omitted.
   */
  dailyLockClearPolicy?: 'NEVER_CLEAR' | 'CLEAR_NEXT_TRADING_DAY' | 'CLEAR_AFTER_1_SESSION' | 'CLEAR_AFTER_3_SESSIONS';
  /** USE_NET_EV_RANKING (Phase C, Task 10) — always false in this phase; net EV is computed and reported as a diagnostic only, never used to pick a different candidate than decideTrade() already selected. Not currently settable to true anywhere in this codebase. */
}

export interface SimulatedTradeV2 extends SimulatedTrade {
  lots: number;
  sizingReason: string | null;
  dailyLocked: boolean;
  costBreakdown: TradeCostBreakdown | null;
  /** totalCost / grossCredit at entry — the diagnostic cost-to-credit filter field (Task 11). Null when grossCredit isn't positive. */
  costToCreditPct: number | null;
  /** Diagnostic only (Task 10) — NEVER used to choose a different candidate than decideTrade() already picked. */
  netEvAtEntry: { netEvRupees: number; netEvPerMaxLoss: number; netEvPerMargin: number | null } | null;
  ivRankAvailable: boolean;
  premiumEdgeAvailable: boolean;
  independentEvAvailable: boolean;
  dataQuality: DataQualityLabels;
}

interface OpenTradeV2 extends OpenTrade {
  lots: number;
  entryFills: SimulatedFill[];
  entryDataQuality: ExecutionDataQuality;
  ivRankAvailable: boolean;
  premiumEdgeAvailable: boolean;
  independentEvAvailable: boolean;
  netEvAtEntry: SimulatedTradeV2['netEvAtEntry'];
}

const USE_NET_EV_RANKING = false; // Task 10 feature flag — always false. Never read anywhere as true in this codebase; ranking stays gross-EV (decideTrade/evaluateExpiries's own evPerUnitRisk) until explicitly approved.

export function simulateSymbolRealistic(days: HistoricalChainDay[], symbol: string, params: RealisticSimulateParams): SimulatedTradeV2[] {
  const trades: SimulatedTradeV2[] = [];
  let open: OpenTradeV2 | null = null;
  const thresholds = params.qualityThresholds ?? DEFAULT_DECISION_THRESHOLDS;
  const exitParams = { ...DEFAULT_EXIT_PARAMS, ...params.exitParams };
  const fillMode: FillMode = params.fillMode ?? 'REALISTIC';
  const riskLimits = params.riskLimits ?? DEFAULT_RISK_LIMITS;
  const dailyLossPct = params.dailyLock?.maxDailyLossPct ?? 4; // options_autotrade_settings' own default
  const maxConsecutiveLosses = params.dailyLock?.maxConsecutiveLosses ?? 3; // options_autotrade_settings' own default
  const sizingEnabled = params.startingEquity !== undefined && params.startingEquity > 0;

  // Portfolio/risk state, tracked chronologically across the whole run —
  // this IS what makes sizing/daily-lock genuinely portfolio-aware rather
  // than a fixed 1-lot-per-signal assumption (QUANT_AUDIT.md Task 8/9).
  let realizedPnlToday = 0;
  let realizedPnlThisWeek = 0;
  let consecutiveLosses = 0;
  let currentWeekKey: string | null = null;
  let currentDayKey: string | null = null;
  const clearPolicy = params.dailyLockClearPolicy ?? 'NEVER_CLEAR';
  // Sessions (day-loop iterations, not calendar days) the lock stays
  // enforced for, counting the trigger day itself as session 0 — e.g.
  // CLEAR_NEXT_TRADING_DAY=1 means locked only on the trigger day, unlocked
  // starting the very next iteration.
  const CLEAR_AFTER_SESSIONS: Record<NonNullable<RealisticSimulateParams['dailyLockClearPolicy']>, number> = {
    NEVER_CLEAR: Infinity, CLEAR_NEXT_TRADING_DAY: 1, CLEAR_AFTER_1_SESSION: 2, CLEAR_AFTER_3_SESSIONS: 4,
  };
  let lockTriggeredAtIndex: number | null = null;

  const closesByDate = (params.historicalCloses ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const ivHistory = params.ivHistory ?? [];

  const weekKeyOf = (dateISO: string) => {
    const d = new Date(`${dateISO}T00:00:00Z`);
    return `${d.getUTCFullYear()}-W${Math.floor((d.getUTCDate() + d.getUTCDay()) / 7)}-${d.getUTCMonth()}`;
  };

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const isLastDay = i === days.length - 1;

    // Daily/weekly realized-P&L resets — chronological, exactly once per
    // new calendar day/week encountered in the walk (never resets mid-day
    // on re-entry into the same date).
    if (day.date !== currentDayKey) { currentDayKey = day.date; realizedPnlToday = 0; }
    const weekKey = weekKeyOf(day.date);
    if (weekKey !== currentWeekKey) { currentWeekKey = weekKey; realizedPnlThisWeek = 0; }

    if (open) {
      const rowsByKey = new Map(day.rows.map((r) => [`${r.strike}:${r.right}:${r.expiry}`, r]));
      let currentCostToClose = 0;
      let missing = false;
      const exitLegQuotes: LegQuote[] = [];
      for (const leg of open.legs) {
        const row = rowsByKey.get(`${leg.strike}:${leg.right}:${open.expiry}`);
        if (!row) { missing = true; break; }
        currentCostToClose += (leg.side === 'SELL' ? 1 : -1) * row.settle * open.lotSize;
        // Exit direction flips the entry side (closing a SELL means BUYing back).
        exitLegQuotes.push({
          side: leg.side === 'BUY' ? 'SELL' : 'BUY', tradingsymbol: `${symbol}:${leg.strike}:${leg.right}`,
          bid: null, ask: null, referencePrice: row.settle, spreadPct: null,
          openInterest: row.openInterest, volume: row.volume,
        });
      }

      if (!missing) {
        const dte = Math.round((Date.parse(`${open.expiry}T00:00:00Z`) - Date.parse(`${day.date}T00:00:00Z`)) / 86_400_000);
        const shortStrikes: ShortStrike[] = open.legs.filter((l) => l.side === 'SELL').map((l) => ({ strike: l.strike, right: l.right }));
        const decision = day.spot
          ? evaluateExit({ maxProfit: open.maxProfit, maxLoss: open.maxLoss, currentCostToClose, dte, underlyingPrice: day.spot, shortStrikes, ...exitParams })
          : null;

        const closeOut = (exitReason: string) => {
          const exitFills = simulateStructureFill(exitLegQuotes, fillMode);
          const legsWithExit = open!.legs.map((l, idx) => ({ ...l, exitPrice: exitFills[idx]?.filledPrice ?? null }));
          const trade = finalizeTradeV2({ ...open!, legs: legsWithExit }, symbol, day.date, exitReason, currentCostToClose, exitFills, fillMode);
          trades.push(trade);
          if (trade.netPnl !== null) {
            realizedPnlToday += trade.netPnl;
            realizedPnlThisWeek += trade.netPnl;
            consecutiveLosses = trade.netPnl < 0 ? consecutiveLosses + 1 : 0;
          }
          open = null;
        };

        if (decision?.action === 'CLOSE') { closeOut(decision.reason ?? 'UNKNOWN'); continue; }
        if (isLastDay) { closeOut('DATA_END'); continue; }
      } else if (isLastDay) {
        trades.push(finalizeTradeV2(open, symbol, day.date, 'DATA_END', null, [], fillMode));
        open = null;
      }
      continue; // one position at a time — never also evaluate a new entry on a day a position is open
    }

    // Daily risk lock (Task 9) — checked BEFORE any candidate is even
    // built, mirroring dailyRiskLock.ts's own "blanket refusal" posture.
    // Existing positions are still managed above regardless of this flag.
    const lockState: DailyRiskState = { realizedPnlToday, consecutiveLosses };
    const equityForLock = params.startingEquity ?? 0;
    const lock = equityForLock > 0
      ? checkDailyRiskLock(lockState, { equity: equityForLock, maxDailyLossPct: dailyLossPct, maxConsecutiveLosses })
      : { locked: false };

    if (lock.locked) {
      if (lockTriggeredAtIndex === null) lockTriggeredAtIndex = i; // first day this specific lock episode became active
      const sessionsElapsed = i - lockTriggeredAtIndex;
      const clearsAfter = CLEAR_AFTER_SESSIONS[clearPolicy];
      if (sessionsElapsed < clearsAfter) continue; // still enforced under this operator policy
      // Operator-simulated clear (backtest-only — see dailyLockClearPolicy's
      // own doc comment; production's real lock never does this on its own).
      consecutiveLosses = 0;
      lockTriggeredAtIndex = null;
    } else {
      lockTriggeredAtIndex = null; // no active lock episode right now
    }

    // No open position: try to enter.
    const payload = buildChainPayload(day, symbol);
    if (!payload) continue;
    const { chain } = normalise(payload);
    const enriched = enrichChain(chain);
    if (enriched.slices.length === 0) continue;

    const step = enriched.slices[0].quotes.length
      ? inferStrikeStep([...new Set(enriched.slices[0].quotes.map((q) => q.quote.strike))].sort((a, b) => a - b))
      : 50;

    // POINT-IN-TIME slice (Task 5): only closes dated <= today's simulated
    // date are ever passed downstream — the exact leakage guard tested in
    // src/quant/__tests__/ivRankHistory.test.ts, applied here to the
    // underlying-closes series too.
    const closesUpToToday = closesByDate.filter((c) => c.date <= day.date);
    const ivRankOutcome = enriched.slices[0]
      ? computePointInTimeIvRank(ivHistory, day.date, atmIvOf(enriched.slices[0]))
      : { available: false as const, reason: 'no slice' };

    const evaluations = evaluateExpiries(enriched, {
      wingWidths: params.wingWidths.length ? params.wingWidths : [2, 4, 6].map((m) => m * step),
      deltaTargets: params.deltaTargets,
      minDte: params.minDte, maxDte: params.maxDte,
      lotSize: 1,
      ivRank: ivRankOutcome.available ? ivRankOutcome.result.rank : null,
      historicalCloses: closesUpToToday.length > 0 ? closesUpToToday : undefined,
    });
    const decision = decideTrade(evaluations, thresholds);
    if (decision.action === 'NO_TRADE' || !decision.expiryEvaluation?.best) continue;

    const best = decision.expiryEvaluation.best;
    const lotSizeExchange = day.lotSize && day.lotSize > 0 ? day.lotSize : 1;

    // Position sizing (Task 8) — the SAME production computePositionSize,
    // never reimplemented. Margin is HISTORICAL_MODEL (approximated as
    // maxLoss — the standard defined-risk-spread exchange-margin proxy),
    // never LIVE_KITE, since no real historical broker margin exists to
    // query. Falls back to a fixed 1 lot (simulateSymbol()'s own behavior)
    // when startingEquity wasn't supplied, clearly labeled either way.
    let lots = 1;
    let sizingReason: string | null = null;
    if (sizingEnabled) {
      const approxMarginPerLot = best.result.maxLoss; // HISTORICAL_MODEL proxy — see DataQualityLabels.margin
      const openPositions: OpenPositionSummary[] = []; // one-position-at-a-time backtest — never > 0 here by construction
      const portfolio: PortfolioState = { openPositions, realizedPnlToday, realizedPnlThisWeek };
      const sizing = computePositionSize(
        { pricing: { maxLoss: best.result.maxLoss, maxProfit: best.result.maxProfit, netCredit: best.result.netCredit, netGreeks: best.result.netGreeks }, marginRequiredPerLot: approxMarginPerLot, underlyingGroup: symbol },
        { equity: params.startingEquity!, availableFunds: params.startingEquity! },
        portfolio, riskLimits,
      );
      lots = sizing.lots;
      sizingReason = sizing.reason;
      if (lots === 0) continue; // a real risk limit blocked this trade — no position opened, matching production's own NO_TRADE-on-zero-lots behavior
    }

    // Net EV (Task 10) — diagnostic only, computed from the SAME
    // independent-EV read evaluateExpiries already attached to `best`
    // (via decision.expiryEvaluation), scaled for real transaction costs.
    // USE_NET_EV_RANKING stays false: this NEVER changes which candidate
    // was selected above.
    const netEvAtEntry = (() => {
      const grossEvPerUnit = best.qualityScore.raw.independentEvPerUnitRisk;
      if (grossEvPerUnit === null) return null;
      const grossEvRupees = grossEvPerUnit * best.result.maxLoss * lotSizeExchange * lots;
      // Approximate expected round-trip cost at entry time (real cost is
      // only known for certain at exit — this is a forward ESTIMATE using
      // the SAME cost model, at the entry-time credit as a turnover proxy).
      const approxEntryTurnover = best.result.netCredit * lotSizeExchange * lots;
      const approxCost = computeTradeCostBreakdown({
        grossCredit: best.result.netCredit * lotSizeExchange * lots, grossPnl: 0,
        legs: best.result.legs.map((l) => ({ side: l.side, entryTurnover: l.price * lotSizeExchange * lots, exitTurnover: l.price * lotSizeExchange * lots })),
        entrySlippage: 0, exitSlippage: 0, leggingCost: 0, tradeDate: day.date,
      });
      const netEvRupees = grossEvRupees - approxCost.totalCost;
      const maxLossRupees = best.result.maxLoss * lotSizeExchange * lots;
      return {
        netEvRupees, netEvPerMaxLoss: maxLossRupees > 0 ? netEvRupees / maxLossRupees : 0,
        netEvPerMargin: null, // HISTORICAL_MODEL margin only — see costToCreditPct/dataQuality for the disclosed proxy instead
      };
    })();

    // Entry fills — simulated the SAME way exits are, so entry and exit
    // both carry a real, disclosed slippage assumption rather than the
    // entry alone being priced at an idealized settlement.
    const entryLegQuotes: LegQuote[] = best.result.legs.map((l) => ({
      side: l.side, tradingsymbol: `${symbol}:${l.strike}:${l.right}`,
      bid: null, ask: null, referencePrice: l.price, spreadPct: null,
      openInterest: null, volume: null,
    }));
    const entryFills = simulateStructureFill(entryLegQuotes, fillMode);

    open = {
      strategyLabel: decision.expiryEvaluation.strategyLabel,
      entryDate: day.date,
      expiry: new Date(decision.expiryEvaluation.expiry).toISOString().slice(0, 10),
      legs: best.result.legs.map((l, idx) => ({ side: l.side, right: l.right, strike: l.strike, entryPrice: entryFills[idx].filledPrice, exitPrice: null })),
      qualityScore: best.qualityScore.score,
      entryDte: decision.expiryEvaluation.dte,
      maxProfit: best.result.maxProfit * lotSizeExchange * lots,
      maxLoss: best.result.maxLoss * lotSizeExchange * lots,
      lotSize: lotSizeExchange * lots,
      lots,
      entryFills,
      entryDataQuality: entryFills[0]?.executionDataQuality ?? 'EOD_APPROXIMATION',
      ivRankAvailable: ivRankOutcome.available,
      premiumEdgeAvailable: best.qualityScore.raw.premiumEdgePct !== null,
      independentEvAvailable: best.qualityScore.raw.independentEvPerUnitRisk !== null,
      netEvAtEntry,
    };
  }

  return trades;

  function finalizeTradeV2(
    openTrade: OpenTradeV2, sym: string, exitDate: string, exitReason: string,
    currentCostToClose: number | null, exitFills: ReturnType<typeof simulateStructureFill>, mode: FillMode,
  ): SimulatedTradeV2 {
    let grossPnl: number | null = null;
    let costBreakdown: TradeCostBreakdown | null = null;
    let netPnl: number | null = null;
    let costToCreditPct: number | null = null;

    const everyLegPriced = openTrade.legs.every((l) => l.exitPrice !== null);
    if (currentCostToClose !== null && everyLegPriced) {
      grossPnl = openTrade.maxProfit - currentCostToClose;
      const entrySlippage = openTrade.entryFills.reduce((s, f) => s + Math.abs(f.slippageRupees), 0) * (openTrade.lotSize);
      const exitSlippage = exitFills.reduce((s, f) => s + Math.abs(f.slippageRupees), 0) * (openTrade.lotSize);
      costBreakdown = computeTradeCostBreakdown({
        grossCredit: openTrade.maxProfit, grossPnl,
        legs: openTrade.legs.map((l) => ({ side: l.side, entryTurnover: l.entryPrice * openTrade.lotSize, exitTurnover: l.exitPrice! * openTrade.lotSize })),
        entrySlippage, exitSlippage, leggingCost: 0, tradeDate: exitDate,
      });
      netPnl = costBreakdown.netPnl;
      costToCreditPct = openTrade.maxProfit > 0 ? (costBreakdown.totalCost / openTrade.maxProfit) * 100 : null;
    }

    const executionQuality: ExecutionDataQuality = openTrade.entryDataQuality;
    return {
      symbol: sym, strategyLabel: openTrade.strategyLabel, entryDate: openTrade.entryDate, exitDate, expiry: openTrade.expiry,
      legs: openTrade.legs, qualityScore: openTrade.qualityScore, entryDte: openTrade.entryDte,
      maxProfit: openTrade.maxProfit, maxLoss: openTrade.maxLoss,
      exitReason, grossPnl, charges: costBreakdown ? costBreakdown.totalCost : null, netPnl,
      lots: openTrade.lots, sizingReason: null, dailyLocked: false,
      costBreakdown, costToCreditPct, netEvAtEntry: openTrade.netEvAtEntry,
      ivRankAvailable: openTrade.ivRankAvailable, premiumEdgeAvailable: openTrade.premiumEdgeAvailable, independentEvAvailable: openTrade.independentEvAvailable,
      dataQuality: {
        pricingData: 'EOD_SETTLEMENT', bidAsk: 'UNAVAILABLE',
        execution: executionQuality, historicalIv: openTrade.ivRankAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
        margin: 'HISTORICAL_MODEL', slippageConfidence: mode === 'IDEAL' ? 'LOW' : mode === 'STRESS' ? 'MEDIUM' : 'LOW',
      },
    };
  }
}

export function simulateSymbol(days: HistoricalChainDay[], symbol: string, params: SimulateParams): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  let open: OpenTrade | null = null;
  const thresholds = params.qualityThresholds ?? DEFAULT_DECISION_THRESHOLDS;
  const exitParams = { ...DEFAULT_EXIT_PARAMS, ...params.exitParams };

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const isLastDay = i === days.length - 1;

    if (open) {
      const rowsByKey = new Map(day.rows.map((r) => [`${r.strike}:${r.right}:${r.expiry}`, r]));
      let currentCostToClose = 0;
      let missing = false;
      for (const leg of open.legs) {
        const row = rowsByKey.get(`${leg.strike}:${leg.right}:${open.expiry}`);
        if (!row) { missing = true; break; }
        currentCostToClose += (leg.side === 'SELL' ? 1 : -1) * row.settle * open.lotSize;
      }

      if (!missing) {
        const dte = Math.round((Date.parse(`${open.expiry}T00:00:00Z`) - Date.parse(`${day.date}T00:00:00Z`)) / 86_400_000);
        const shortStrikes: ShortStrike[] = open.legs.filter((l) => l.side === 'SELL').map((l) => ({ strike: l.strike, right: l.right }));
        const decision = day.spot
          ? evaluateExit({ maxProfit: open.maxProfit, maxLoss: open.maxLoss, currentCostToClose, dte, underlyingPrice: day.spot, shortStrikes, ...exitParams })
          : null;

        if (decision?.action === 'CLOSE') {
          const legsWithExit = open.legs.map((l) => {
            const row = rowsByKey.get(`${l.strike}:${l.right}:${open!.expiry}`);
            return { ...l, exitPrice: row?.settle ?? null };
          });
          trades.push(finalizeTrade({ ...open, legs: legsWithExit }, symbol, day.date, decision.reason ?? 'UNKNOWN', currentCostToClose));
          open = null;
          continue;
        }
        if (isLastDay) {
          const legsWithExit = open.legs.map((l) => {
            const row = rowsByKey.get(`${l.strike}:${l.right}:${open!.expiry}`);
            return { ...l, exitPrice: row?.settle ?? null };
          });
          trades.push(finalizeTrade({ ...open, legs: legsWithExit }, symbol, day.date, 'DATA_END', currentCostToClose));
          open = null;
          continue;
        }
      } else if (isLastDay) {
        trades.push(finalizeTrade(open, symbol, day.date, 'DATA_END', null));
        open = null;
      }
      continue; // one position at a time — never also evaluate a new entry on a day a position is open
    }

    // No open position: try to enter.
    const payload = buildChainPayload(day, symbol);
    if (!payload) continue;
    const { chain } = normalise(payload);
    const enriched = enrichChain(chain);
    if (enriched.slices.length === 0) continue;

    const step = enriched.slices[0].quotes.length
      ? inferStrikeStep([...new Set(enriched.slices[0].quotes.map((q) => q.quote.strike))].sort((a, b) => a - b))
      : 50;
    const evaluations = evaluateExpiries(enriched, {
      wingWidths: params.wingWidths.length ? params.wingWidths : [2, 4, 6].map((m) => m * step),
      deltaTargets: params.deltaTargets,
      minDte: params.minDte, maxDte: params.maxDte,
      lotSize: 1, // priced per single contract here; day.lotSize applied when computing rupee P&L
      ivRank: null,
    });
    const decision = decideTrade(evaluations, thresholds);
    if (decision.action === 'NO_TRADE' || !decision.expiryEvaluation?.best) continue;

    const best = decision.expiryEvaluation.best;
    const lotSize = day.lotSize && day.lotSize > 0 ? day.lotSize : 1;
    open = {
      strategyLabel: decision.expiryEvaluation.strategyLabel,
      entryDate: day.date,
      expiry: new Date(decision.expiryEvaluation.expiry).toISOString().slice(0, 10),
      legs: best.result.legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, entryPrice: l.price, exitPrice: null })),
      qualityScore: best.qualityScore.score,
      entryDte: decision.expiryEvaluation.dte,
      maxProfit: best.result.maxProfit * lotSize,
      maxLoss: best.result.maxLoss * lotSize,
      lotSize,
    };
  }

  return trades;
}
