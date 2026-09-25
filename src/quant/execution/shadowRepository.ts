/**
 * The persistence surface for SHADOW's live-data-capture writes (Tasks
 * 2/3/4). Same minimal-store-interface pattern as orderIntent.ts/
 * forwardLedger.ts — a tiny interface, not the Supabase client directly,
 * so write behavior (including failure handling) is unit-testable without
 * a real database.
 *
 * SOFT_FAIL vs FAIL_CLOSED (Task 3): every write in this file is SOFT_FAIL
 * — a telemetry failure here NEVER blocks or aborts the trading decision
 * itself (that would make research logging a new way to break live
 * trading, which is unacceptable). The one place this module enforces a
 * FAIL_CLOSED-shaped consequence is indirect: shadowExecution.ts's
 * isEligibleForForwardValidation() marks a signal ineligible for the
 * OFFICIAL sample when a required write failed — the trading/paper-
 * tracking side is unaffected, only the research-sample eligibility is.
 */

export interface OptionChainSnapshotRow {
  scanId: string;
  capturedAt: string;
  symbol: string;
  spot: number | null;
  indiaVix: number | null;
  forward: number | null;
  expiry: string;
  calendarDte: number;
  tradingSessionHorizon: number;
  strike: number;
  optionRight: 'CE' | 'PE';
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  ltp: number | null;
  markPrice: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

export interface IvHistoryRow {
  capturedAt: string;
  symbol: string;
  expiry: string;
  atmStrike: number;
  atmCallIv: number | null;
  atmPutIv: number | null;
  combinedAtmIv: number | null;
  calendarDte: number;
  tradingSessionHorizon: number;
  spot: number | null;
  indiaVix: number | null;
}

export interface ExecutionQualityRow {
  scanId: string;
  candidateId: string | null;
  intentId: string | null;
  positionId: number | null;
  legId: string | null;
  symbol: string;
  strategyLabel: string | null;
  expiry: string;
  strike: number;
  optionRight: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  quantity: number;
  executionMode: 'PAPER' | 'SHADOW' | 'AUTO';
  fillModel: string;
  /**
   * Forward-validation readiness phase, Task 2: which side of the round
   * trip this row belongs to. Required to sum entry-side cost separately
   * from exit-side cost, and to never double-count either — a caller
   * summing `entryExecutionCost` for a forward_ledger_id MUST filter on
   * phase='ENTRY' (there is exactly one such batch per ledger row, written
   * once at signal time; a second batch is impossible because the position
   * insert that follows is itself gated by the order-intent's atomic
   * claim).
   */
  phase: 'ENTRY' | 'EXIT';
  /** Links this telemetry row back to the SAME forward_validation_ledger row this signal/outcome was recorded under (migration 012). Null only for PAPER/AUTO rows, which never populate a ledger id at all. */
  forwardLedgerId: string | null;
  decisionAt: string;
  quoteAt: string | null;
  submittedAt: string | null;
  filledAt: string | null;
  decisionMid: number | null;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  submittedPrice: number | null;
  actualFill: number | null;
  slippageRupees: number | null;
  slippageBps: number | null;
  latencyMs: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  dte: number | null;
  indiaVix: number | null;
  brokerOrderId: string | null;
  fillIsSimulated: boolean;
}

export interface ShadowRepository {
  insertChainSnapshots(rows: OptionChainSnapshotRow[]): Promise<{ ok: true } | { error: string }>;
  insertIvHistory(rows: IvHistoryRow[]): Promise<{ ok: true } | { error: string }>;
  insertExecutionQuality(rows: ExecutionQualityRow[]): Promise<{ ok: true } | { error: string }>;
  /** Task 2: real entry-side slippage cost for a completed SHADOW trade's ledger row — null (never 0) when unavailable. */
  sumEntryExecutionCost(forwardLedgerId: string): Promise<{ value: number | null; rowCount: number }>;
}

/** Production adapter — batches every insert (Task 3: "one insert per scan per symbol where practical", never one request per contract). Typed loosely for the same reason orderIntent.ts's/forwardLedger.ts's adapters are — see their own comments. */
export function supabaseShadowRepository(supabase: any): ShadowRepository {
  return {
    async insertChainSnapshots(rows) {
      if (rows.length === 0) return { ok: true };
      const { error } = await supabase.from('options_chain_snapshots').insert(rows.map((r) => ({
        scan_id: r.scanId, captured_at: r.capturedAt, symbol: r.symbol, spot: r.spot, india_vix: r.indiaVix,
        forward: r.forward, expiry: r.expiry, calendar_dte: r.calendarDte, trading_session_horizon: r.tradingSessionHorizon,
        strike: r.strike, option_right: r.optionRight, bid: r.bid, bid_qty: r.bidQty, ask: r.ask, ask_qty: r.askQty,
        ltp: r.ltp, mark_price: r.markPrice, volume: r.volume, open_interest: r.openInterest,
        iv: r.iv, delta: r.delta, gamma: r.gamma, theta: r.theta, vega: r.vega,
      })));
      if (error) return { error: error.message };
      return { ok: true };
    },
    async insertIvHistory(rows) {
      if (rows.length === 0) return { ok: true };
      const { error } = await supabase.from('options_iv_history').insert(rows.map((r) => ({
        captured_at: r.capturedAt, symbol: r.symbol, expiry: r.expiry, atm_strike: r.atmStrike,
        atm_iv: r.combinedAtmIv ?? r.atmCallIv ?? r.atmPutIv ?? 0,
        calendar_dte: r.calendarDte, trading_session_horizon: r.tradingSessionHorizon, spot: r.spot, india_vix: r.indiaVix,
      })));
      if (error) return { error: error.message };
      return { ok: true };
    },
    async insertExecutionQuality(rows) {
      if (rows.length === 0) return { ok: true };
      // Forward-validation readiness phase, Task 2 fix: scan_id,
      // candidate_id, phase and forward_ledger_id were already present on
      // every ExecutionQualityRow the caller built, and their columns
      // already exist (migration 012), but this mapping silently dropped
      // all four before they ever reached the DB — meaning
      // entryExecutionCost could never have been looked up from real
      // telemetry, no matter what the caller computed. Now persisted.
      const { error } = await supabase.from('options_execution_quality').insert(rows.map((r) => ({
        position_id: r.positionId, leg_id: r.legId, execution_mode: r.executionMode, strategy_label: r.strategyLabel,
        symbol: r.symbol, dte: r.dte, delta: r.delta, india_vix: r.indiaVix, open_interest: r.openInterest, volume: r.volume,
        decision_at: r.decisionAt, quote_at: r.quoteAt, submitted_at: r.submittedAt, filled_at: r.filledAt,
        decision_mid: r.decisionMid, bid: r.bid, ask: r.ask, submitted_limit: r.submittedPrice, actual_fill: r.actualFill,
        spread_pct: r.spreadPct, slippage_rupees: r.slippageRupees, slippage_bps: r.slippageBps, latency_ms: r.latencyMs,
        leg_sequence: null, quantity: r.quantity, broker_order_id: r.brokerOrderId, fill_is_simulated: r.fillIsSimulated,
        scan_id: r.scanId, candidate_id: r.candidateId, phase: r.phase, forward_ledger_id: r.forwardLedgerId,
      })));
      if (error) return { error: error.message };
      return { ok: true };
    },
    /**
     * Task 2: the entry-side cost lookup a SHADOW exit needs to stop
     * hard-coding entryExecutionCost to 0 — sums the REAL, already-
     * persisted entry-side slippage for this exact forward_ledger_id.
     * Filtering on phase='ENTRY' is what prevents ever double-counting an
     * exit-side row (they share the same forward_ledger_id but the
     * opposite phase). Returns null (never 0) when no rows are found or
     * the query fails — a caller must treat that as "not available", not
     * "zero cost".
     */
    async sumEntryExecutionCost(forwardLedgerId) {
      const { data, error } = await supabase
        .from('options_execution_quality')
        .select('slippage_rupees')
        .eq('forward_ledger_id', forwardLedgerId)
        .eq('phase', 'ENTRY');
      if (error || !data || data.length === 0) return { value: null, rowCount: 0 };
      const value = data.reduce((sum: number, r: any) => sum + Math.abs(Number(r.slippage_rupees) || 0), 0);
      return { value, rowCount: data.length };
    },
  };
}

/** De-duplicates IV-history rows within a single scan (Task 4: "do not duplicate the same row repeatedly within a single scan") — one row per (symbol, expiry), last-write-wins WITHIN the batch, before it ever reaches the repository. */
export function dedupeIvHistoryRows(rows: IvHistoryRow[]): IvHistoryRow[] {
  const byKey = new Map<string, IvHistoryRow>();
  for (const row of rows) byKey.set(`${row.symbol}:${row.expiry}`, row);
  return [...byKey.values()];
}
