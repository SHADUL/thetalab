/**
 * Independent PAPER/SHADOW/AUTO profile toggles (replacing the old
 * mutually-exclusive `execution_mode` enum) — a user can now run e.g.
 * SHADOW and AUTO simultaneously, each executing its own full, independent
 * copy of the same scan decision.
 *
 * Backward compatible by construction: `options_autotrade_settings` gets
 * three new nullable boolean columns (migration 019). Until that migration
 * is applied, `select('*')` simply omits them from the returned row (never
 * errors), so `paper_enabled`/`shadow_enabled`/`auto_enabled` come back
 * `undefined` and this function transparently falls back to deriving a
 * single enabled mode from the legacy `execution_mode` column — the exact
 * behavior that was already live. Once the migration runs and a caller
 * explicitly sets any of the three booleans, the toggles take over and
 * multiple modes can be enabled at once.
 */

export type ExecutionProfile = 'PAPER' | 'SHADOW' | 'AUTO';

export interface ExecutionProfileSettings {
  execution_mode?: string | null;
  paper_enabled?: boolean | null;
  shadow_enabled?: boolean | null;
  auto_enabled?: boolean | null;
}

const ALL_PROFILES: readonly ExecutionProfile[] = ['PAPER', 'SHADOW', 'AUTO'];

const TOGGLE_FIELD: Record<ExecutionProfile, 'paper_enabled' | 'shadow_enabled' | 'auto_enabled'> = {
  PAPER: 'paper_enabled', SHADOW: 'shadow_enabled', AUTO: 'auto_enabled',
};

/** true once ANY toggle column has been explicitly set (migration applied and configured at least once) — the presence signal that switches this settings row over to independent-toggle semantics. */
export function hasExecutionProfileToggles(settings: ExecutionProfileSettings): boolean {
  return settings.paper_enabled !== null && settings.paper_enabled !== undefined
    || settings.shadow_enabled !== null && settings.shadow_enabled !== undefined
    || settings.auto_enabled !== null && settings.auto_enabled !== undefined;
}

/** Every profile that should run this cycle, in a stable PAPER/SHADOW/AUTO order. */
export function deriveEnabledExecutionProfiles(settings: ExecutionProfileSettings): ExecutionProfile[] {
  if (hasExecutionProfileToggles(settings)) {
    return ALL_PROFILES.filter((p) => settings[TOGGLE_FIELD[p]] === true);
  }
  const legacy = settings.execution_mode;
  return legacy === 'PAPER' || legacy === 'SHADOW' || legacy === 'AUTO' ? [legacy] : [];
}
