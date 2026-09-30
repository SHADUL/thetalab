/**
 * θ₁–θ₃₉ parameter register — exact values from
 * NIFTY_ALPHA_LADDER_SPEC_RECONSTRUCTION.md §2 (PDF Appendix A). No magic
 * numbers belong anywhere else in src/nifty-alpha-ladder/ — every module
 * imports the named constant it needs from THETA below, never a literal.
 *
 * Read-only by design (spec's own Calibration and Parameter Governance
 * section, and your instruction §47): this is a calibrated production
 * parameter set, not a tunable-by-default settings surface.
 */

export const STRATEGY_VERSION = 'HEDGED133_V3_0';

export interface ParameterDefinition {
  symbol: string;
  name: string;
  value: unknown;
  unit: string;
  description: string;
  sourceSection: string;
  version: typeof STRATEGY_VERSION;
}

export const PARAMETER_REGISTER: ParameterDefinition[] = [
  { symbol: 'θ1', name: 'Large-order quantile level', value: 0.85, unit: 'quantile', description: 'Quantile of per-window displayed level-size distribution folded into the large-order reference threshold.', sourceSection: 'Appendix A / Def 13.3', version: STRATEGY_VERSION },
  { symbol: 'θ2', name: 'Large-order threshold warm-up count', value: 150_000, unit: 'depth observations', description: 'Minimum cumulative level observations before large-order classification activates for a contract.', sourceSection: 'Appendix A / Def 2.2, 13.3', version: STRATEGY_VERSION },
  { symbol: 'θ3', name: 'Large-order reference window', value: 15, unit: 'minutes', description: 'Width of successive aggregation windows whose quantiles are folded into the reference threshold.', sourceSection: 'Appendix A / Def 13.3', version: STRATEGY_VERSION },
  { symbol: 'θ4', name: 'Aggregate-imbalance snapshot interval', value: 3, unit: 'minutes', description: 'Width of the interval over which full-book bid/ask quantities are aggregated into one G2 snapshot.', sourceSection: 'Appendix A / Def 2.6', version: STRATEGY_VERSION },
  { symbol: 'θ5', name: 'Imbalance-ratio crossing level', value: 9.0, unit: 'cumulative-ratio units', description: 'Absolute level of G2 whose first attainment fires the signal before the cutoff.', sourceSection: 'Appendix A / Eq 4.5', version: STRATEGY_VERSION },
  { symbol: 'θ6', name: 'Sign tolerance', value: 1e-4, unit: 'area units', description: 'Dead-band below which a signed area is treated as neutral in sgn_ε.', sourceSection: 'Appendix A / Def 2.4', version: STRATEGY_VERSION },
  { symbol: 'θ7', name: 'Calm-regime volatility cutoff', value: 12.5, unit: 'India VIX points', description: 'VIX (read at the signal bar) below which Variation C may act.', sourceSection: 'Appendix A / Eq 4.11', version: STRATEGY_VERSION },
  { symbol: 'θ8', name: 'Strong-read level', value: 4.5, unit: 'cumulative-ratio units', description: '|G2| at the signal instant below which the order-flow read is classified as weak for Variation C.', sourceSection: 'Appendix A / Eq 4.10', version: STRATEGY_VERSION },
  { symbol: 'θ9', name: 'Volatility bar granularity', value: 15, unit: 'minutes', description: 'India VIX bar width; latest bar at/before signal instant is v*.', sourceSection: 'Appendix A / Def 2.1', version: STRATEGY_VERSION },
  { symbol: 'θ10', name: 'Monitor-leg recommendation band', value: 0.005, unit: 'fraction of F0', description: 'Indicative band published with the monitor call (informational only).', sourceSection: 'Appendix A', version: STRATEGY_VERSION },
  { symbol: 'θ11', name: 'Structure recommendation band', value: 0.05, unit: 'fraction of first-leg premium', description: 'Indicative band published with each structure call (informational only).', sourceSection: 'Appendix A', version: STRATEGY_VERSION },
  { symbol: 'θ12', name: 'Marketable-limit proportional buffer', value: 0.08, unit: 'fraction of LTP', description: 'Proportional distance through the touch for every option limit order.', sourceSection: 'Appendix A / Eq 7.1', version: STRATEGY_VERSION },
  { symbol: 'θ13', name: 'Marketable-limit absolute floor', value: 3.00, unit: '₹ per option unit', description: 'Minimum absolute buffer; dominates θ12 on low premiums.', sourceSection: 'Appendix A / Eq 7.1', version: STRATEGY_VERSION },
  { symbol: 'θ14', name: 'Inter-leg release spacing', value: 750, unit: 'milliseconds', description: "Pause between a leg's confirmed fill and release of the next leg.", sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ15', name: 'Fill-gate broker-phase cap', value: 75, unit: 'seconds', description: 'Max time an entry leg may be un-terminal while not yet OPEN at the exchange.', sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ16', name: 'Fill-gate exchange-phase cap', value: 45, unit: 'seconds', description: 'Additional time once observed OPEN at the exchange.', sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ17', name: 'Fill-gate absolute ceiling', value: 100, unit: 'seconds', description: 'Hard cap from placement regardless of phase.', sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ18', name: 'Order-book read schedule', value: [0.5, 1.2, 2.5, 5, 8], unit: 'seconds after placement', description: 'Front-loaded reads before the sparse cadence begins.', sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ19', name: 'Sparse read period', value: 12, unit: 'seconds', description: 'Read cadence after the front-loaded schedule is exhausted.', sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ20', name: 'Read back-off', value: 20, unit: 'seconds', description: 'Minimum delay before the next read after a failed read.', sourceSection: 'Appendix A / Def 7.4', version: STRATEGY_VERSION },
  { symbol: 'θ21', name: 'Session-recovery budget', value: 4, unit: 'recoveries', description: 'Max session-token recoveries per gate/monitor before treated non-transient.', sourceSection: 'Appendix A / Def 7.3', version: STRATEGY_VERSION },
  { symbol: 'θ22', name: 'Same-day entry cap', value: 3, unit: 'trade events', description: 'Max same-day trade events per account per algo.', sourceSection: 'Appendix A / Gate 5.11', version: STRATEGY_VERSION },
  { symbol: 'θ23', name: 'Conflict-query timeout', value: 5, unit: 'seconds', description: 'Timeout of the opposite-position query; fails open.', sourceSection: 'Appendix A / Gate 5.9', version: STRATEGY_VERSION },
  { symbol: 'θ24', name: 'Rollback status-lookup window', value: 45, unit: 'seconds', description: 'Window over which rollback retries the order-status read of each placed leg.', sourceSection: 'Appendix A / Def 7.5', version: STRATEGY_VERSION },
  { symbol: 'θ25', name: 'Rollback re-check window', value: 20, unit: 'seconds', description: 'Window over which status is re-read after a blind cancel.', sourceSection: 'Appendix A / Def 7.5', version: STRATEGY_VERSION },
  { symbol: 'θ26', name: 'Cancel settle delay', value: 4, unit: 'seconds', description: 'Delay between a rollback cancel and re-reading status.', sourceSection: 'Appendix A / Def 7.5', version: STRATEGY_VERSION },
  { symbol: 'θ27', name: 'Exit short-close gate', value: 60, unit: 'seconds', description: "Max wait for a short leg's buy-to-close to reach COMPLETE before protective legs may release.", sourceSection: 'Appendix A / Def 9.4', version: STRATEGY_VERSION },
  { symbol: 'θ28', name: 'Exit order-fetch retry budget', value: 5, unit: 'attempts', description: "Attempts (linear back-off) to read a leg's open ledger rows before an exit aborts in full.", sourceSection: 'Appendix A / Def 9.4', version: STRATEGY_VERSION },
  { symbol: 'θ29', name: 'Exit-monitor first-check interval', value: [10, 20], unit: 'seconds (uniform random)', description: 'First status check of a resting exit limit order.', sourceSection: 'Appendix A / Def 9.5', version: STRATEGY_VERSION },
  { symbol: 'θ30', name: 'Exit re-pricing schedule Φx(i)', value: { lt5: 0.025, lt12: 0.05, ge12: 0.10 }, unit: 'fraction of LTP', description: 'Escalating buffer at the i-th re-pricing of a resting option exit order.', sourceSection: 'Appendix A / Eq 9.2', version: STRATEGY_VERSION },
  { symbol: 'θ31', name: 'Late-session stretch schedule Φℓ(i)', value: { lt5: 0.18, lt12: 0.24, ge12: 0.30 }, unit: 'fraction of LTP', description: 'Floor applied to Φx(i) for option exit orders still resting after 15:20.', sourceSection: 'Appendix A / Eq 9.2', version: STRATEGY_VERSION },
  { symbol: 'θ32', name: 'Scheduled-exit attempt budget', value: 5, unit: 'attempts', description: 'Attempts of the scheduled force-exit (and of the safety-net exit) before an unsettled alert is raised.', sourceSection: 'Appendix A / Def 9.1, 9.2', version: STRATEGY_VERSION },
  { symbol: 'θ33', name: 'Scheduled-exit retry interval', value: 2, unit: 'minutes', description: 'Interval between scheduled force-exit attempts.', sourceSection: 'Appendix A / Def 9.1', version: STRATEGY_VERSION },
  { symbol: 'θ34', name: 'Post-trade synchroniser delay', value: 3, unit: 'minutes', description: 'Delay after a multi-leg entry or exit at which the first reconciliation pass runs; the second runs one further delay later.', sourceSection: 'Appendix A', version: STRATEGY_VERSION },
  { symbol: 'θ35', name: 'Leftover-check delay', value: 12, unit: 'minutes', description: "Delay after a call's recorded exit time at which the ledger is checked for any leg without an exit order.", sourceSection: 'Appendix A', version: STRATEGY_VERSION },
  { symbol: 'θ36', name: 'Leftover-check look-back', value: 90, unit: 'minutes', description: 'Look-back horizon within which closed calls not yet verified are picked up by the leftover check.', sourceSection: 'Appendix A', version: STRATEGY_VERSION },
  { symbol: 'θ37', name: 'Leftover-check attempt budget', value: 3, unit: 'attempts', description: 'Attempts before a call whose ledger cannot be read is reported as unverifiable.', sourceSection: 'Appendix A', version: STRATEGY_VERSION },
  { symbol: 'θ38', name: 'Broker-position cache lifetime', value: 10, unit: 'seconds', description: 'Lifetime of a broker positions read shared by the legs of one exit for the broker-truth quantity clamp.', sourceSection: 'Appendix A / Def 9.3', version: STRATEGY_VERSION },
  { symbol: 'θ39', name: 'Structure unit margin', value: 340_000, unit: '₹ per structure unit', description: 'Capital budget for ONE complete unit of the structure, used to convert allocated capital into an integer number of units.', sourceSection: 'Appendix A / Def 6.1', version: STRATEGY_VERSION },
];

const byId = new Map(PARAMETER_REGISTER.map((p) => [p.symbol, p]));
function req<T>(symbol: string): T {
  const p = byId.get(symbol);
  if (!p) throw new Error(`Unknown parameter ${symbol}`);
  return p.value as T;
}

/** Typed, named access — every consuming module imports from here, never a literal. */
export const THETA = {
  LARGE_ORDER_QUANTILE: req<number>('θ1'),
  LARGE_ORDER_WARMUP_COUNT: req<number>('θ2'),
  LARGE_ORDER_REFERENCE_WINDOW_MIN: req<number>('θ3'),
  AGGREGATE_SNAPSHOT_INTERVAL_MIN: req<number>('θ4'),
  IMBALANCE_CROSSING_LEVEL: req<number>('θ5'),
  SIGN_TOLERANCE: req<number>('θ6'),
  CALM_VIX_CUTOFF: req<number>('θ7'),
  STRONG_READ_LEVEL: req<number>('θ8'),
  VIX_BAR_GRANULARITY_MIN: req<number>('θ9'),
  MONITOR_RECOMMENDATION_BAND: req<number>('θ10'),
  STRUCTURE_RECOMMENDATION_BAND: req<number>('θ11'),
  MARKETABLE_LIMIT_PROPORTIONAL_BUFFER: req<number>('θ12'),
  MARKETABLE_LIMIT_ABSOLUTE_FLOOR: req<number>('θ13'),
  INTER_LEG_RELEASE_SPACING_MS: req<number>('θ14'),
  FILL_GATE_BROKER_PHASE_CAP_SEC: req<number>('θ15'),
  FILL_GATE_EXCHANGE_PHASE_CAP_SEC: req<number>('θ16'),
  FILL_GATE_ABSOLUTE_CEILING_SEC: req<number>('θ17'),
  ORDER_BOOK_READ_SCHEDULE_SEC: req<number[]>('θ18'),
  SPARSE_READ_PERIOD_SEC: req<number>('θ19'),
  READ_BACKOFF_SEC: req<number>('θ20'),
  SESSION_RECOVERY_BUDGET: req<number>('θ21'),
  SAME_DAY_ENTRY_CAP: req<number>('θ22'),
  CONFLICT_QUERY_TIMEOUT_SEC: req<number>('θ23'),
  ROLLBACK_STATUS_LOOKUP_SEC: req<number>('θ24'),
  ROLLBACK_RECHECK_SEC: req<number>('θ25'),
  CANCEL_SETTLE_DELAY_SEC: req<number>('θ26'),
  EXIT_SHORT_CLOSE_GATE_SEC: req<number>('θ27'),
  EXIT_ORDER_FETCH_RETRY_BUDGET: req<number>('θ28'),
  EXIT_MONITOR_FIRST_CHECK_SEC: req<[number, number]>('θ29'),
  EXIT_REPRICING_SCHEDULE: req<{ lt5: number; lt12: number; ge12: number }>('θ30'),
  LATE_SESSION_STRETCH_SCHEDULE: req<{ lt5: number; lt12: number; ge12: number }>('θ31'),
  SCHEDULED_EXIT_ATTEMPT_BUDGET: req<number>('θ32'),
  SCHEDULED_EXIT_RETRY_MIN: req<number>('θ33'),
  POST_TRADE_SYNC_DELAY_MIN: req<number>('θ34'),
  LEFTOVER_CHECK_DELAY_MIN: req<number>('θ35'),
  LEFTOVER_CHECK_LOOKBACK_MIN: req<number>('θ36'),
  LEFTOVER_CHECK_ATTEMPT_BUDGET: req<number>('θ37'),
  BROKER_POSITION_CACHE_SEC: req<number>('θ38'),
  STRUCTURE_UNIT_MARGIN: req<number>('θ39'),
} as const;

/** A1 decision (per your instruction): future live SHADOW/AUTO uses the nearest NIFTY futures depth as the fallback/only source — never represented as the PDF's own proprietary primary spot-order-flow source, which this codebase does not have access to. Not used by any Milestone-2 module (no live data here); recorded here so the naming is fixed for Milestone 3+. */
export const FUTURES_DEPTH_FALLBACK_MODE = 'FUTURES_DEPTH_FALLBACK_MODE' as const;
