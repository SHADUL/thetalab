/**
 * Data-quality health panel (live-data-capture phase, Task 14). Computes
 * plain ingestion-success percentages from already-fetched records —
 * never silently continues research on incomplete telemetry without
 * surfacing that fact. A caller (dashboard, or a report generator) decides
 * what to DO with a bad number; this module only measures it honestly.
 */

export interface SnapshotRecord {
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  iv: number | null;
  capturedAt: string; // ISO timestamp
}

export interface ExecutionQualityRecord {
  fillIsSimulated: boolean;
  actualFill: number | null;
}

export interface IvHistoryRecord {
  symbol: string;
  expiry: string;
}

export interface DataQualityHealth {
  snapshotIngestionSuccessPct: number | null;
  missingBidAskPct: number | null;
  missingOpenInterestPct: number | null;
  staleQuotePct: number | null;
  missingIvPct: number | null;
  executionTelemetrySuccessPct: number | null;
  ivHistoryCoveragePct: number | null;
  /** True when ANY of the above is below its own healthy threshold — the caller must surface this, never continue silently (Task 14's explicit instruction). */
  hasQualityIssue: boolean;
}

export interface HealthThresholds {
  minSnapshotIngestionPct: number;
  maxMissingBidAskPct: number;
  maxMissingOiPct: number;
  maxStaleQuotePct: number;
  maxMissingIvPct: number;
  minExecutionTelemetryPct: number;
  minIvHistoryCoveragePct: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  minSnapshotIngestionPct: 95, maxMissingBidAskPct: 10, maxMissingOiPct: 10,
  maxStaleQuotePct: 5, maxMissingIvPct: 10, minExecutionTelemetryPct: 95, minIvHistoryCoveragePct: 80,
};

export function computeDataQualityHealth(
  input: {
    /** Snapshots actually captured this period. */
    snapshots: SnapshotRecord[];
    /** Expected snapshot count for this period, from the scan schedule — null when unknown (health for ingestion success is then reported null, not fabricated as 100%). */
    expectedSnapshotCount: number | null;
    maxQuoteAgeMs: number;
    nowMs: number;
    executionRecords: ExecutionQualityRecord[];
    expectedExecutionRecordCount: number | null;
    ivHistory: IvHistoryRecord[];
    /** Every (symbol, expiry) pair the live scan actually evaluated this period — used to compute coverage as "how many of these have at least one IV history row." */
    evaluatedSymbolExpiries: Array<{ symbol: string; expiry: string }>;
  },
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): DataQualityHealth {
  const n = input.snapshots.length;

  const snapshotIngestionSuccessPct = input.expectedSnapshotCount !== null && input.expectedSnapshotCount > 0
    ? Math.min(100, (n / input.expectedSnapshotCount) * 100) : null;

  const missingBidAskPct = n > 0 ? (input.snapshots.filter((s) => s.bid === null || s.ask === null).length / n) * 100 : null;
  const missingOpenInterestPct = n > 0 ? (input.snapshots.filter((s) => s.openInterest === null).length / n) * 100 : null;
  const missingIvPct = n > 0 ? (input.snapshots.filter((s) => s.iv === null).length / n) * 100 : null;
  const staleQuotePct = n > 0
    ? (input.snapshots.filter((s) => input.nowMs - Date.parse(s.capturedAt) > input.maxQuoteAgeMs).length / n) * 100
    : null;

  const executionTelemetrySuccessPct = input.expectedExecutionRecordCount !== null && input.expectedExecutionRecordCount > 0
    ? Math.min(100, (input.executionRecords.length / input.expectedExecutionRecordCount) * 100) : null;

  const evaluatedKeys = new Set(input.evaluatedSymbolExpiries.map((e) => `${e.symbol}:${e.expiry}`));
  const coveredKeys = new Set(input.ivHistory.map((r) => `${r.symbol}:${r.expiry}`));
  const ivHistoryCoveragePct = evaluatedKeys.size > 0
    ? ([...evaluatedKeys].filter((k) => coveredKeys.has(k)).length / evaluatedKeys.size) * 100 : null;

  const checks: Array<[number | null, number, boolean]> = [
    [snapshotIngestionSuccessPct, thresholds.minSnapshotIngestionPct, true],
    [missingBidAskPct, thresholds.maxMissingBidAskPct, false],
    [missingOpenInterestPct, thresholds.maxMissingOiPct, false],
    [staleQuotePct, thresholds.maxStaleQuotePct, false],
    [missingIvPct, thresholds.maxMissingIvPct, false],
    [executionTelemetrySuccessPct, thresholds.minExecutionTelemetryPct, true],
    [ivHistoryCoveragePct, thresholds.minIvHistoryCoveragePct, true],
  ];
  // higherIsBetter=true -> issue when value < threshold; false -> issue when value > threshold.
  const hasQualityIssue = checks.some(([value, threshold, higherIsBetter]) =>
    value !== null && (higherIsBetter ? value < threshold : value > threshold));

  return {
    snapshotIngestionSuccessPct, missingBidAskPct, missingOpenInterestPct, staleQuotePct, missingIvPct,
    executionTelemetrySuccessPct, ivHistoryCoveragePct, hasQualityIssue,
  };
}
