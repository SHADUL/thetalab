/**
 * Runtime SHADOW safety guard — the second, independent layer alongside
 * the static mode-safety test. The static test proves no broker order-
 * mutation code exists in this module's SOURCE; this guard proves that
 * even if one were ever introduced by mistake, it could not execute
 * silently in SHADOW mode. Every place in this codebase that would ever
 * call a real broker order-placement/modification/cancellation function
 * MUST wrap that call with `assertNotShadowMode` first.
 */
import type { ExecutionMode } from '../types.ts';

export class CriticalShadowInvariantError extends Error {
  constructor(action: string) {
    super(`CRITICAL_SHADOW_INVARIANT: attempted a real broker mutation ("${action}") while execution mode is SHADOW. This must never happen — SHADOW places zero real orders, by construction.`);
    this.name = 'CriticalShadowInvariantError';
  }
}

export interface CriticalEventLogger {
  logCritical(message: string, detail: unknown): Promise<void>;
}

/**
 * Call at the very top of any function that is ABOUT to place, modify or
 * cancel a real broker order — before any network call. Throws a hard
 * error and logs a CRITICAL activity event if `mode` is SHADOW. In
 * Milestone 3, `mode` is always SHADOW (AUTO has zero real implementation
 * yet — see the mode-safety test), so this guard is always active; it
 * remains the enforcement point once Milestone 5 adds a real AUTO path.
 */
export async function assertNotShadowMode(mode: ExecutionMode, action: string, logger?: CriticalEventLogger): Promise<void> {
  if (mode === 'SHADOW') {
    const err = new CriticalShadowInvariantError(action);
    if (logger) {
      await logger.logCritical(err.message, { action, mode }).catch(() => {
        // Logging failure must never suppress the hard error itself —
        // the throw below is the actual safety mechanism; the log is best-effort telemetry on top of it.
      });
    }
    throw err;
  }
}
