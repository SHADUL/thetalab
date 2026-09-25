/**
 * Pre-entry broker reconciliation (QUANT_AUDIT.md Task 3): compares this
 * system's own internal state (DB positions, DB positions already flagged
 * for manual reconciliation, and any still-open order intents) against
 * Kite's actual, independent order book and position book, BEFORE an AUTO
 * entry is allowed to proceed.
 *
 * Deliberately a PURE function over already-fetched inputs — same
 * discipline as preTradeValidation.ts and positionSizing.ts. Fetching live
 * Kite order/position data is the caller's job (api/options-autotrade.ts);
 * this module only classifies what it's given, so the classification logic
 * itself is fully unit-testable without a real broker connection.
 *
 * This module NEVER decides to flatten an unknown broker position. Its
 * only two effects are (1) a classification and (2) a list of specific,
 * human-readable findings — the caller decides what to do with a
 * MISMATCH/RECONCILIATION_REQUIRED result (per the task: block new
 * entries, keep risk-REDUCING management of already-understood positions
 * running, and surface a prominent alert).
 */

export type ReconciliationStatus = 'MATCHED' | 'SAFE_NO_POSITION' | 'MISMATCH' | 'RECONCILIATION_REQUIRED';

export interface DbPositionLeg {
  tradingsymbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  strike: number;
  right: 'CE' | 'PE';
}

export interface DbPositionSummary {
  id: number;
  symbol: string;
  expiry: string;
  legs: DbPositionLeg[];
}

/** A non-terminal order intent (CLAIMED/EXECUTING/ABANDONED) — see orderIntent.ts. */
export interface OpenIntentSummary {
  id: string;
  symbol: string;
  status: 'CLAIMED' | 'EXECUTING' | 'ABANDONED';
  intentKey: string;
  ageMs: number;
}

/** From Kite's /positions — net, non-zero-quantity option positions only
    (the caller filters out flat/closed lines before calling this). */
export interface BrokerPosition {
  tradingsymbol: string;
  /** Signed: positive = net long, negative = net short (Kite's own convention). */
  quantity: number;
}

export type BrokerOrderStatus =
  | 'COMPLETE' | 'OPEN' | 'TRIGGER PENDING' | 'PARTIALLY FILLED' | 'REJECTED' | 'CANCELLED' | 'UNKNOWN';

/** From Kite's /orders — today's orders only (the caller scopes the date range). */
export interface BrokerOrder {
  orderId: string;
  tradingsymbol: string;
  status: BrokerOrderStatus;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  filledQuantity: number;
}

export interface ReconciliationFinding {
  code:
    | 'DB_POSITION_MISSING_AT_BROKER' | 'BROKER_POSITION_MISSING_IN_DB'
    | 'QUANTITY_MISMATCH' | 'SIDE_MISMATCH'
    | 'ORPHAN_HEDGE' | 'ORPHAN_SHORT'
    | 'OPEN_ORDER_UNTRACKED' | 'PARTIALLY_FILLED_ORDER' | 'REJECTED_ORDER' | 'CANCELLED_ORDER'
    | 'AMBIGUOUS_ORDER_STATUS' | 'ABANDONED_INTENT' | 'KNOWN_RECONCILIATION_PENDING';
  severity: 'info' | 'blocking';
  message: string;
}

export interface ReconciliationInput {
  /** Positions this system believes are currently open and healthy. */
  dbActivePositions: DbPositionSummary[];
  /** Positions ALREADY flagged (CLOSE_FAILED / RECONCILIATION_REQUIRED /
      PARTIALLY_FILLED elsewhere in this codebase) — their mere presence is
      itself a blocking finding; this module doesn't need to know why. */
  dbPendingReconciliation: DbPositionSummary[];
  openIntents: OpenIntentSummary[];
  brokerPositions: BrokerPosition[];
  brokerOrders: BrokerOrder[];
}

export interface ReconciliationResult {
  status: ReconciliationStatus;
  findings: ReconciliationFinding[];
}

function sideOf(qty: number): 'BUY' | 'SELL' {
  return qty >= 0 ? 'BUY' : 'SELL';
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const findings: ReconciliationFinding[] = [];

  // A position this codebase has ALREADY flagged as needing a human to
  // reconcile it against the broker directly (see position-monitor's own
  // CLOSE_FAILED handling) is an immediate, unconditional block — this
  // module doesn't re-diagnose it, it just refuses to add MORE exposure
  // on top of an already-known-uncertain state.
  for (const p of input.dbPendingReconciliation) {
    findings.push({
      code: 'KNOWN_RECONCILIATION_PENDING', severity: 'blocking',
      message: `Position #${p.id} (${p.symbol} ${p.expiry}) is already flagged for manual reconciliation.`,
    });
  }

  // An ABANDONED intent means a PREVIOUS invocation claimed an entry and
  // never reached a terminal state (crash, timeout, cold-start kill) — the
  // broker may or may not hold a real position from that attempt. This is
  // exactly the ambiguity the task requires blocking on, not guessing at.
  for (const intent of input.openIntents) {
    if (intent.status === 'ABANDONED') {
      findings.push({
        code: 'ABANDONED_INTENT', severity: 'blocking',
        message: `Order intent ${intent.id} (${intent.symbol}) was claimed but never reached a terminal ` +
          `status (age ${Math.round(intent.ageMs / 1000)}s) — broker state for this attempt is unknown.`,
      });
    }
  }

  // Build lookup maps keyed by tradingsymbol — Kite's own unit of a
  // distinct contract, so this is the correct join key between "a DB leg"
  // and "a broker position line."
  const dbLegsBySymbol = new Map<string, DbPositionLeg & { positionId: number }>();
  for (const p of input.dbActivePositions) {
    for (const leg of p.legs) dbLegsBySymbol.set(leg.tradingsymbol, { ...leg, positionId: p.id });
  }
  const brokerBySymbol = new Map(input.brokerPositions.filter((b) => b.quantity !== 0).map((b) => [b.tradingsymbol, b]));

  // DB says a leg is open; does the broker agree?
  for (const [symbol, leg] of dbLegsBySymbol) {
    const broker = brokerBySymbol.get(symbol);
    if (!broker) {
      findings.push({
        code: 'DB_POSITION_MISSING_AT_BROKER', severity: 'blocking',
        message: `Position #${leg.positionId}'s leg ${symbol} (${leg.side} ${leg.quantity}) is ACTIVE in the ` +
          `database but no matching position exists at the broker.`,
      });
      continue;
    }
    const expectedSignedQty = leg.side === 'BUY' ? leg.quantity : -leg.quantity;
    if (Math.abs(broker.quantity) !== leg.quantity) {
      findings.push({
        code: 'QUANTITY_MISMATCH', severity: 'blocking',
        message: `Position #${leg.positionId}'s leg ${symbol}: DB expects quantity ${leg.quantity}, broker ` +
          `reports ${Math.abs(broker.quantity)}.`,
      });
    } else if (sideOf(broker.quantity) !== leg.side) {
      findings.push({
        code: 'SIDE_MISMATCH', severity: 'blocking',
        message: `Position #${leg.positionId}'s leg ${symbol}: DB expects ${leg.side}, broker position sign ` +
          `implies ${sideOf(broker.quantity)}.`,
      });
    } else if (expectedSignedQty !== broker.quantity) {
      // Quantity magnitude and side both individually matched their own
      // checks above but the signed values still disagree — a case the
      // two narrower checks above wouldn't each catch alone (defensive;
      // should not be reachable if both prior checks passed, but a wrong
      // assumption in one of them must not silently pass here).
      findings.push({
        code: 'QUANTITY_MISMATCH', severity: 'blocking',
        message: `Position #${leg.positionId}'s leg ${symbol}: signed quantity mismatch — DB expects ` +
          `${expectedSignedQty}, broker reports ${broker.quantity}.`,
      });
    }
  }

  // Broker says a position is open; does the DB know about it at all?
  for (const [symbol, broker] of brokerBySymbol) {
    if (!dbLegsBySymbol.has(symbol)) {
      // Classify as an orphaned hedge (a long leg with no corresponding
      // short in our records — usually harmless directionally, but still
      // unaccounted capital) vs. an orphaned short (a naked, unbounded-risk
      // position this system has no record of protecting) — the side is
      // read straight off the broker's own signed quantity.
      const side = sideOf(broker.quantity);
      findings.push({
        code: side === 'BUY' ? 'ORPHAN_HEDGE' : 'ORPHAN_SHORT', severity: 'blocking',
        message: `Broker holds a position in ${symbol} (${side} ${Math.abs(broker.quantity)}) with no ` +
          `matching ACTIVE position in the database.`,
      });
    }
  }

  // Any order still genuinely in flight at the broker, or in a state this
  // system can't cleanly interpret, blocks new entries — a NEW entry
  // shouldn't be layered on top of unresolved broker-side order state.
  for (const order of input.brokerOrders) {
    if (order.status === 'OPEN' || order.status === 'TRIGGER PENDING') {
      findings.push({
        code: 'OPEN_ORDER_UNTRACKED', severity: 'blocking',
        message: `Order ${order.orderId} (${order.transactionType} ${order.tradingsymbol}) is still ${order.status} at the broker.`,
      });
    } else if (order.status === 'PARTIALLY FILLED') {
      findings.push({
        code: 'PARTIALLY_FILLED_ORDER', severity: 'blocking',
        message: `Order ${order.orderId} (${order.tradingsymbol}) is PARTIALLY FILLED ` +
          `(${order.filledQuantity}/${order.quantity}) at the broker.`,
      });
    } else if (order.status === 'UNKNOWN') {
      findings.push({
        code: 'AMBIGUOUS_ORDER_STATUS', severity: 'blocking',
        message: `Order ${order.orderId} (${order.tradingsymbol}) returned an unrecognized status from the broker.`,
      });
    } else if (order.status === 'REJECTED') {
      findings.push({ code: 'REJECTED_ORDER', severity: 'info', message: `Order ${order.orderId} (${order.tradingsymbol}) was REJECTED — no position resulted.` });
    } else if (order.status === 'CANCELLED') {
      findings.push({ code: 'CANCELLED_ORDER', severity: 'info', message: `Order ${order.orderId} (${order.tradingsymbol}) was CANCELLED — no position resulted.` });
    }
    // COMPLETE orders need no finding here — they're exactly what a
    // matched position/DB pair already accounts for above.
  }

  const blocking = findings.filter((f) => f.severity === 'blocking');
  if (blocking.length > 0) {
    // ABANDONED intents and ambiguous/partial broker order states mean the
    // true state literally cannot be determined from what we can see —
    // RECONCILIATION_REQUIRED. A clean disagreement between two otherwise-
    // legible sources (DB says X, broker says Y, both individually
    // unambiguous) is a MISMATCH — still blocking, but a narrower claim.
    const trulyAmbiguous = blocking.some((f) =>
      f.code === 'ABANDONED_INTENT' || f.code === 'PARTIALLY_FILLED_ORDER' ||
      f.code === 'AMBIGUOUS_ORDER_STATUS' || f.code === 'KNOWN_RECONCILIATION_PENDING');
    return { status: trulyAmbiguous ? 'RECONCILIATION_REQUIRED' : 'MISMATCH', findings };
  }

  if (input.dbActivePositions.length === 0 && input.brokerPositions.filter((b) => b.quantity !== 0).length === 0) {
    return { status: 'SAFE_NO_POSITION', findings };
  }
  return { status: 'MATCHED', findings };
}
