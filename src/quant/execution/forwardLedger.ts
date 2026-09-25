/**
 * The forward-validation ledger writer (FORWARD_VALIDATION_PROTOCOL.md,
 * live-data-capture phase Task 7, extended in the lifecycle-completion
 * phase Task 6/9/10). Every SHADOW signal is recorded via `recordSignal`
 * BEFORE its outcome is known; `recordOutcome` is the ONLY function
 * permitted to touch a row again afterward, and it is structurally
 * incapable of writing anything but the fixed set of outcome-suffixed
 * columns — there is no code path in this module that can overwrite a
 * pre-trade field once inserted, which is the actual guarantee behind
 * "never edit the original pre-trade signal fields after outcome," not
 * just a documented convention someone could accidentally violate.
 *
 * `recordOutcome` is also the completion IDEMPOTENCY GUARD (Task 9/10): the
 * production adapter's UPDATE is scoped to `WHERE completed = false`, an
 * atomic conditional write, not a SELECT-then-UPDATE check — two
 * concurrent monitor invocations racing to close the SAME SHADOW position
 * can both attempt `recordOutcome`, but at most one UPDATE actually
 * matches a row (Postgres's own row-level locking is the real mechanism,
 * the same class of guarantee orderIntent.ts's partial unique index
 * provides for entries). The loser gets `{ alreadyCompleted: true }`, not
 * a silently-duplicated write.
 *
 * Same minimal-store pattern as orderIntent.ts: a tiny interface, not the
 * Supabase client directly, so the write discipline itself is unit-
 * testable against a plain in-memory store.
 */

export interface ForwardSignal {
  symbol: string;
  strategyLabel: string;
  expiry: string; // "YYYY-MM-DD"
  calendarDte: number;
  tradingSessionHorizon: number;
  shortDeltaTarget: number | null;
  wingWidth: number | null;
  netCredit: number;
  estimatedMaxLoss: number;
  estimatedPop: number | null;
  expectedValue: number | null;
  premiumEdgePct: number | null;
  independentEvPerUnitRisk: number | null;
  /** Null when unavailable at signal time — never fabricated (matches ivRankHistory.ts's own discipline). */
  ivRank: number | null;
  liquidityTier: string | null;
  marketRegime: string | null;
  sizingLots: number | null;
  expectedCostsRupees: number | null;
  intentId?: string | null;
  /**
   * Task 13: reproducibility fingerprint, captured at signal time. Every
   * official trade must be provably from the SAME frozen baseline/fill-
   * model/protocol/code revision — this is what lets a future report
   * assert that, not just assume it. protocolId is null for any signal
   * recorded before a protocol run exists (a real, honest PRE_PROTOCOL
   * state, never fabricated).
   */
  baselineVersion: string;
  fillModelVersion: string;
  protocolId: string | null;
  codeVersion: string | null;
}

export interface ForwardOutcome {
  exitReason: string;
  holdingPeriodDays: number;
  /** Task 3: MID-to-MID economic payoff — see executionCost.ts for the canonical definition. */
  grossPnl: number;
  /** = grossPnl - entryExecutionCost - exitExecutionCost - transactionChargesEstimate (executionCost.ts's computeCanonicalForwardPnl). This IS realized_hypothetical_pnl (migration 010's original column) — kept under both names in the DB for backward compatibility with anything already reading realized_hypothetical_pnl. */
  netPnl: number;
  /** Slippage cost only — see executionCost.ts. Never includes statutory charges. */
  entryExecutionCost: number;
  exitExecutionCost: number;
  /** = entryExecutionCost + exitExecutionCost, exactly (executionCost.ts) — transaction charges are deliberately NOT included here. */
  totalExecutionCost: number;
  /** Task 2: brokerage/STT/exchange/SEBI/stamp-duty/GST, kept separate from slippage on purpose — see executionCost.ts's estimateTransactionCharges. */
  transactionChargesEstimate: number;
  costModelVersion: string;
  /** Task 7: NULL, honestly, until real intratrade marks are persisted — see MAE_MFE_UNAVAILABLE. Never fabricated. */
  maxAdverseExcursion: number | null;
  maxFavorableExcursion: number | null;
  /** Task 11: forward observability only — never used to auto-clear anything. */
  dailyLockState: { wouldTriggerMaxDailyLoss: boolean; wouldTriggerMaxConsecutiveLosses: boolean; realizedPnlTodayAfterThisTrade: number; consecutiveLossesAfterThisTrade: number };
  dataQuality: Record<string, unknown>;
}

export type RecordOutcomeResult = { ok: true } | { alreadyCompleted: true } | { error: string };

export interface PersistedOutcomeRead {
  completed: boolean;
  exitReason: string | null;
  netPnl: number | null;
  outcomeRecordedAtIso: string | null;
}

export interface ForwardLedgerStore {
  /** Inserts a new signal row (all outcome_* columns null, completed=false) and returns its id. */
  insertSignal(signal: ForwardSignal): Promise<{ id: string }>;
  /**
   * Sets ONLY the outcome_* columns for an existing row, plus
   * outcome_recorded_at and completed=true — ATOMICALLY conditioned on
   * completed still being false. Must never accept or write any pre-trade
   * field — the type signature itself (ForwardOutcome, disjoint from
   * ForwardSignal) is what makes that structurally true.
   */
  recordOutcome(ledgerId: string, outcome: ForwardOutcome): Promise<RecordOutcomeResult>;
  /**
   * Forward-start blocker phase, Task 3: a READ-ONLY accessor — no side
   * effects, never touches `completed` or any other column. Exists solely
   * so a LEDGER_COMPLETED + POSITION_ACTIVE recovery (see
   * shadowConsistency.ts / SHADOW_EXIT_RECOVERY.md) can read back the
   * FIRST, already-persisted outcome and finalize the position from those
   * exact values, instead of ever re-simulating a second exit.
   */
  getOutcome(ledgerId: string): Promise<{ found: false } | { found: true; outcome: PersistedOutcomeRead }>;
}

export async function recordSignal(store: ForwardLedgerStore, signal: ForwardSignal): Promise<string> {
  const { id } = await store.insertSignal(signal);
  return id;
}

export async function recordOutcome(store: ForwardLedgerStore, ledgerId: string, outcome: ForwardOutcome): Promise<RecordOutcomeResult> {
  return store.recordOutcome(ledgerId, outcome);
}

/** Production adapter — see orderIntent.ts's supabaseOrderIntentStore for why this is typed loosely (`any`) rather than fighting supabase-js's own generic builder types. */
export function supabaseForwardLedgerStore(supabase: any): ForwardLedgerStore {
  return {
    async insertSignal(signal) {
      const { data, error } = await supabase
        .from('options_forward_validation_ledger')
        .insert({
          symbol: signal.symbol, strategy_label: signal.strategyLabel, expiry: signal.expiry,
          calendar_dte: signal.calendarDte, trading_session_horizon: signal.tradingSessionHorizon,
          short_delta_target: signal.shortDeltaTarget, wing_width: signal.wingWidth,
          net_credit: signal.netCredit, estimated_max_loss: signal.estimatedMaxLoss,
          estimated_pop: signal.estimatedPop, expected_value: signal.expectedValue,
          premium_edge_pct: signal.premiumEdgePct, independent_ev_per_unit_risk: signal.independentEvPerUnitRisk,
          iv_rank: signal.ivRank, liquidity_tier: signal.liquidityTier, market_regime: signal.marketRegime,
          sizing_lots: signal.sizingLots, expected_costs_rupees: signal.expectedCostsRupees,
          intent_id: signal.intentId ?? null,
          baseline_version: signal.baselineVersion, fill_model_version: signal.fillModelVersion,
          protocol_id: signal.protocolId, code_version: signal.codeVersion,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      return { id: data!.id };
    },
    async recordOutcome(ledgerId, outcome) {
      // The idempotency guard: this UPDATE only ever matches a row when
      // completed is STILL false. A second, concurrent call for the same
      // ledgerId — from an overlapping monitor invocation, a retry, or a
      // duplicate cron trigger — matches zero rows and gets told so
      // explicitly, rather than silently overwriting the first outcome.
      const { data, error } = await supabase
        .from('options_forward_validation_ledger')
        .update({
          realized_hypothetical_pnl: outcome.netPnl, // migration 010's original column name, kept in sync
          gross_pnl: outcome.grossPnl,
          holding_period_days: outcome.holdingPeriodDays,
          entry_execution_cost: outcome.entryExecutionCost,
          exit_execution_cost: outcome.exitExecutionCost,
          total_execution_cost: outcome.totalExecutionCost,
          transaction_charges_estimate: outcome.transactionChargesEstimate,
          cost_model_version: outcome.costModelVersion,
          max_adverse_excursion: outcome.maxAdverseExcursion,
          max_favorable_excursion: outcome.maxFavorableExcursion,
          exit_reason: outcome.exitReason,
          observed_execution_cost_estimate: outcome.totalExecutionCost,
          daily_lock_state: outcome.dailyLockState,
          data_quality: outcome.dataQuality,
          outcome_recorded_at: new Date().toISOString(),
          completed: true,
        })
        .eq('id', ledgerId)
        .eq('completed', false)
        .select('id');
      if (error) return { error: error.message };
      if (!data || data.length === 0) return { alreadyCompleted: true };
      return { ok: true };
    },
    async getOutcome(ledgerId) {
      const { data, error } = await supabase
        .from('options_forward_validation_ledger')
        .select('completed,exit_reason,realized_hypothetical_pnl,outcome_recorded_at')
        .eq('id', ledgerId)
        .maybeSingle();
      if (error || !data) return { found: false };
      return {
        found: true,
        outcome: {
          completed: data.completed === true,
          exitReason: data.exit_reason ?? null,
          netPnl: data.realized_hypothetical_pnl !== null && data.realized_hypothetical_pnl !== undefined ? Number(data.realized_hypothetical_pnl) : null,
          outcomeRecordedAtIso: data.outcome_recorded_at ?? null,
        },
      };
    },
  };
}
