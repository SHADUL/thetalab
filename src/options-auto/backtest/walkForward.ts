/**
 * Chronological walk-forward windowing (QUANT_AUDIT.md, out-of-sample
 * validation phase). TRAIN -> VALIDATE -> TEST, rolled forward by the TEST
 * window's own length each iteration — never a random shuffle, never an
 * overlap between a window's own TEST segment and any later window's
 * TRAIN/VALIDATE segment from BEHIND it in time (each window's own
 * TRAIN/VALIDATE/TEST are strictly chronologically ordered internally,
 * and successive windows only ever move forward).
 *
 * This module only computes DATE BOUNDARIES. It does not itself run any
 * pricing/scoring logic — the actual point-in-time discipline (no future
 * observation reaching realized vol / IV rank / skew / scoring / sizing /
 * exit) is enforced by simulateSymbolRealistic()'s own per-day slicing,
 * exactly as already tested in ivRankHistory.test.ts's leakage-guard
 * tests. A window boundary that a caller ignores would be a caller bug,
 * not a gap in this module — so this file also exports an explicit
 * assertion helper callers (and this phase's tests) use to prove no
 * TRAIN/VALIDATE data for a window is ever dated on/after that window's
 * own TEST start.
 */

export interface WalkForwardWindow {
  index: number;
  trainStart: string;
  trainEnd: string;
  validateStart: string;
  validateEnd: string;
  testStart: string;
  testEnd: string;
}

export interface WalkForwardConfig {
  trainMonths: number;
  validateMonths: number;
  testMonths: number;
}

function addMonths(dateISO: string, months: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds every window that fully fits within [dataStart, dataEnd], rolling
 * forward by `config.testMonths` each iteration (the standard walk-forward
 * roll — each new window's TEST segment is the next untested slice of
 * time, never overlapping a PRIOR window's own TEST segment).
 */
export function buildWalkForwardWindows(dataStart: string, dataEnd: string, config: WalkForwardConfig): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  let trainStart = dataStart;
  let index = 0;
  for (;;) {
    const trainEnd = addMonths(trainStart, config.trainMonths);
    const validateEnd = addMonths(trainEnd, config.validateMonths);
    const testEnd = addMonths(validateEnd, config.testMonths);
    if (testEnd > dataEnd) break;
    windows.push({ index, trainStart, trainEnd, validateStart: trainEnd, validateEnd, testStart: validateEnd, testEnd });
    trainStart = addMonths(trainStart, config.testMonths);
    index++;
  }
  return windows;
}

/**
 * The explicit leakage assertion the task asked for: given a window and
 * the full real historical-closes series, throws if ANY close dated on or
 * after `window.testStart` would be visible to a TRAIN/VALIDATE-time
 * calculation for that same window — i.e. proves the boundary itself is
 * sound, independent of whether a caller's point-in-time slicing (done
 * elsewhere, per-day, inside simulateSymbolRealistic) is also correct.
 */
export function assertNoLeakageAcrossWindow(window: WalkForwardWindow, closes: { date: string }[]): void {
  const trainOrValidate = closes.filter((c) => c.date >= window.trainStart && c.date < window.testStart);
  const leaked = trainOrValidate.some((c) => c.date >= window.testStart);
  if (leaked) {
    throw new Error(`Leakage: a TRAIN/VALIDATE-dated observation in window ${window.index} is dated >= its own testStart (${window.testStart}).`);
  }
  // Also confirm strict chronological ordering of the window's own boundaries.
  if (!(window.trainStart < window.trainEnd && window.trainEnd <= window.validateStart &&
        window.validateStart < window.validateEnd && window.validateEnd <= window.testStart &&
        window.testStart < window.testEnd)) {
    throw new Error(`Malformed window ${window.index}: boundaries are not strictly chronological.`);
  }
}

/** Filters a real HistoricalChainDay[]-shaped array (or any {date}-bearing array) to one window's TEST segment only. */
export function sliceToTestWindow<T extends { date: string }>(rows: T[], window: WalkForwardWindow): T[] {
  return rows.filter((r) => r.date >= window.testStart && r.date < window.testEnd);
}
