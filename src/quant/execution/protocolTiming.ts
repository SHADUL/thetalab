/**
 * Protocol-timing eligibility (forward-start blocker phase, Task 2) — a
 * PURE function: every fact about the referenced forward_validation_runs
 * row and the signal itself is supplied by the caller (a DB read happens
 * in api/options-autotrade.ts or the health/eligibility call site, never
 * in here). This is what lets a trade be checked against "was there a
 * genuinely ACTIVE, matching protocol run in effect at signal time"
 * without this module ever touching Supabase.
 *
 * A signal with no protocol_id (PRE_PROTOCOL — recorded before any
 * protocol run existed) is a real, valid state: the trade is RETAINED,
 * just never eligible for the official sample. Never deleted, same
 * discipline as every other eligibility gate in this codebase.
 */

export interface ProtocolRunFacts {
  /** False when no forward_validation_runs row exists at all for the referenced protocol_id. */
  runExists: boolean;
  runStatus: 'ACTIVE' | 'STOPPED' | 'INVALIDATED' | null;
  runProtocolId: string | null;
  runBaselineVersion: string | null;
  runFillModel: string | null;
  runStartedAtMs: number | null;
  /** stopped_at (or an invalidation timestamp), null while the run is still ACTIVE / has never been terminated. */
  runTerminalAtMs: number | null;
}

export interface SignalProtocolFacts {
  signalProtocolId: string | null;
  signalBaselineVersion: string;
  signalFillModelVersion: string;
  signalTimestampMs: number;
}

export interface ProtocolTimingEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export function evaluateProtocolTimingEligibility(
  signal: SignalProtocolFacts,
  run: ProtocolRunFacts,
): ProtocolTimingEligibilityResult {
  const reasons: string[] = [];

  if (signal.signalProtocolId === null) {
    // A real, retained state — never treated as an error, just never
    // eligible for the official sample (matches this codebase's
    // PRE_PROTOCOL convention elsewhere).
    reasons.push('signal has no protocol_id (PRE_PROTOCOL — recorded before any protocol run existed)');
    return { eligible: false, reasons };
  }
  if (!run.runExists || run.runProtocolId === null) {
    reasons.push(`no protocol run found for protocol_id '${signal.signalProtocolId}'`);
    return { eligible: false, reasons };
  }
  if (signal.signalProtocolId !== run.runProtocolId) {
    reasons.push(`protocol_id mismatch: signal references '${signal.signalProtocolId}', run is '${run.runProtocolId}'`);
  }
  if (signal.signalBaselineVersion !== run.runBaselineVersion) {
    reasons.push(`baseline_version mismatch: signal has '${signal.signalBaselineVersion}', run is '${run.runBaselineVersion}'`);
  }
  if (signal.signalFillModelVersion !== run.runFillModel) {
    reasons.push(`fill_model mismatch: signal has '${signal.signalFillModelVersion}', run is '${run.runFillModel}'`);
  }
  if (run.runStartedAtMs !== null && signal.signalTimestampMs < run.runStartedAtMs) {
    reasons.push(`signal recorded (${new Date(signal.signalTimestampMs).toISOString()}) before the protocol run started (${new Date(run.runStartedAtMs).toISOString()})`);
  }
  if (run.runTerminalAtMs !== null && signal.signalTimestampMs >= run.runTerminalAtMs) {
    reasons.push(`signal recorded at/after the protocol run was ${run.runStatus === 'INVALIDATED' ? 'invalidated' : 'stopped'} (${new Date(run.runTerminalAtMs).toISOString()})`);
  }
  // Defensive fallback: a run that is not ACTIVE MUST have a terminal
  // timestamp (that is how stop/invalidate is implemented) — if that
  // invariant is ever violated, never silently treat the run as open.
  if (run.runStatus !== 'ACTIVE' && run.runTerminalAtMs === null) {
    reasons.push(`protocol run status is '${run.runStatus}' but has no terminal timestamp — treating as not ACTIVE`);
  }

  return { eligible: reasons.length === 0, reasons };
}
