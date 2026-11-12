/**
 * NIFTY PULSE strategy configuration and presets.
 *
 * Presets are immutable and versioned. Every paper trade stores the exact
 * config id + version it ran under. Editing settings never mutates a
 * preset: it derives a NEW user version (see deriveVersion).
 *
 * Both presets are paper-only. `paperOnly` is typed as the literal `true`
 * so no config object can even be constructed that claims otherwise.
 */

export interface PulseConfig {
  id: string;
  name: string;
  version: number;
  /** Built-in presets cannot be edited; edits create a derived version. */
  immutable: boolean;
  paperOnly: true;
  /** Preset this version was derived from (null for built-ins). */
  parentId: string | null;
  strategy: 'STRATEGY_A_1S_MOMENTUM_CREDIT_SPREAD';
  description: string;

  // ── Sampling / data quality ──────────────────────────────────────────
  /** A sampled index price older than this (ms since its receipt) is STALE. */
  tickFreshnessMs: number;
  /** An option quote older than this (ms) is not tradeable. */
  quoteFreshnessMs: number;

  // ── Signal (Strategy A baseline) ─────────────────────────────────────
  shortReturnWindowSec: number;   // R5
  longReturnWindowSec: number;    // R15
  maWindowSec: number;            // MA60
  shortReturnThresholdPct: number; // 0.015 (%)
  longReturnThresholdPct: number;  // 0.030 (%)
  confirmLookback: number;        // last 5 one-second changes
  confirmMin: number;             // at least 4 agree

  // ── Spread selection ─────────────────────────────────────────────────
  /** Short strike distance from ATM, in strike steps (0 = ATM). */
  shortOtmStepsMin: number;
  shortOtmStepsMax: number;
  /** Spread width, in strike steps. */
  widthStepsMin: number;
  widthStepsMax: number;
  lots: number;
  /** Minimum gross credit in index points (after slippage). */
  minCreditPts: number;
  /** Per-leg maximum bid/ask spread, points. */
  maxBidAskPts: number;
  /** Per-leg maximum bid/ask spread as % of mid. */
  maxBidAskPct: number;
  /** Top-of-book quantity must cover this multiple of the order quantity. */
  minDepthMultiple: number;

  // ── Exits ────────────────────────────────────────────────────────────
  profitTargetPctOfCredit: number; // 20
  stopLossPctOfCredit: number;     // 30
  maxHoldSec: number;              // 120

  // ── Risk ─────────────────────────────────────────────────────────────
  capital: number;
  maxLossPerTrade: number;
  maxDailyLoss: number;
  maxMarginAllocation: number;
  maxConcurrentPositions: number;
  maxTradesPerDay: number;
  cooldownSec: number;

  // ── Costs ────────────────────────────────────────────────────────────
  /** Flat round-trip estimate (₹) used by the baseline for risk + exit math. */
  roundTripCostEstimate: number;
  /** Slippage per leg per fill, index points, applied against us. */
  slippagePtsPerLeg: number;
  /** FLAT = use roundTripCostEstimate; DETAILED = exchange-schedule model. */
  costModel: 'FLAT' | 'DETAILED';
}

const STRATEGY_A_BASELINE: PulseConfig = Object.freeze({
  id: 'strategy-a-baseline',
  name: 'Strategy A — Baseline',
  version: 1,
  immutable: true,
  paperOnly: true,
  parentId: null,
  strategy: 'STRATEGY_A_1S_MOMENTUM_CREDIT_SPREAD',
  description: 'Exact research baseline: 1-second NIFTY momentum (R5, R15, MA60, 4-of-5 confirmation) into a hedged credit spread. ₹1,000 max risk per trade.',

  tickFreshnessMs: 2_500,
  quoteFreshnessMs: 3_000,

  shortReturnWindowSec: 5,
  longReturnWindowSec: 15,
  maWindowSec: 60,
  shortReturnThresholdPct: 0.015,
  longReturnThresholdPct: 0.030,
  confirmLookback: 5,
  confirmMin: 4,

  shortOtmStepsMin: 0,
  shortOtmStepsMax: 3,
  widthStepsMin: 1,
  widthStepsMax: 4,
  lots: 1,
  minCreditPts: 2,
  maxBidAskPts: 2,
  maxBidAskPct: 6,
  minDepthMultiple: 1,

  profitTargetPctOfCredit: 20,
  stopLossPctOfCredit: 30,
  maxHoldSec: 120,

  capital: 500_000,
  maxLossPerTrade: 1_000,
  maxDailyLoss: 3_000,
  maxMarginAllocation: 100_000,
  maxConcurrentPositions: 1,
  maxTradesPerDay: 5,
  cooldownSec: 60,

  roundTripCostEstimate: 150,
  slippagePtsPerLeg: 0.05,
  costModel: 'FLAT',
});

const STRATEGY_A_EXTENDED: PulseConfig = Object.freeze({
  ...STRATEGY_A_BASELINE,
  id: 'strategy-a-extended-risk',
  name: 'Strategy A — Extended Risk',
  version: 1,
  description: 'Research preset: identical signal, spread and exit rules as the baseline, with ₹2,500 max risk per trade. Daily loss limit unchanged at ₹3,000.',
  maxLossPerTrade: 2_500,
});

export const PRESETS: readonly PulseConfig[] = Object.freeze([STRATEGY_A_BASELINE, STRATEGY_A_EXTENDED]);
export const DEFAULT_PRESET_ID = STRATEGY_A_BASELINE.id;

export function presetById(id: string): PulseConfig | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Stable key stored with every paper trade. */
export function configKey(c: Pick<PulseConfig, 'id' | 'version'>): string {
  return `${c.id}@v${c.version}`;
}

/** Keys that a user may edit. Identity / safety fields are never editable. */
export const EDITABLE_KEYS = [
  'tickFreshnessMs', 'quoteFreshnessMs',
  'shortReturnWindowSec', 'longReturnWindowSec', 'maWindowSec',
  'shortReturnThresholdPct', 'longReturnThresholdPct', 'confirmLookback', 'confirmMin',
  'shortOtmStepsMin', 'shortOtmStepsMax', 'widthStepsMin', 'widthStepsMax', 'lots',
  'minCreditPts', 'maxBidAskPts', 'maxBidAskPct', 'minDepthMultiple',
  'profitTargetPctOfCredit', 'stopLossPctOfCredit', 'maxHoldSec',
  'capital', 'maxLossPerTrade', 'maxDailyLoss', 'maxMarginAllocation',
  'maxConcurrentPositions', 'maxTradesPerDay', 'cooldownSec',
  'roundTripCostEstimate', 'slippagePtsPerLeg', 'costModel',
] as const satisfies ReadonlyArray<keyof PulseConfig>;

export type EditableKey = (typeof EDITABLE_KEYS)[number];

export interface ValidationIssue { key: EditableKey; message: string }

/** Rejects settings that would make the engine meaningless or unsafe. */
export function validateConfig(c: PulseConfig): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const pos = (k: EditableKey) => { if (!((c[k] as number) > 0)) out.push({ key: k, message: 'must be greater than 0' }); };
  const nonNeg = (k: EditableKey) => { if (!((c[k] as number) >= 0)) out.push({ key: k, message: 'cannot be negative' }); };
  const int = (k: EditableKey) => { if (!Number.isInteger(c[k] as number)) out.push({ key: k, message: 'must be a whole number' }); };

  for (const k of ['tickFreshnessMs', 'quoteFreshnessMs', 'shortReturnWindowSec', 'longReturnWindowSec', 'maWindowSec',
    'shortReturnThresholdPct', 'longReturnThresholdPct', 'confirmLookback', 'confirmMin', 'widthStepsMin', 'widthStepsMax',
    'lots', 'profitTargetPctOfCredit', 'stopLossPctOfCredit', 'maxHoldSec', 'capital', 'maxLossPerTrade', 'maxDailyLoss',
    'maxMarginAllocation', 'maxConcurrentPositions', 'maxTradesPerDay', 'maxBidAskPts', 'maxBidAskPct', 'minDepthMultiple'] as const) pos(k);
  for (const k of ['shortOtmStepsMin', 'shortOtmStepsMax', 'minCreditPts', 'cooldownSec', 'roundTripCostEstimate', 'slippagePtsPerLeg'] as const) nonNeg(k);
  for (const k of ['shortReturnWindowSec', 'longReturnWindowSec', 'maWindowSec', 'confirmLookback', 'confirmMin', 'shortOtmStepsMin',
    'shortOtmStepsMax', 'widthStepsMin', 'widthStepsMax', 'lots', 'maxConcurrentPositions', 'maxTradesPerDay', 'cooldownSec', 'maxHoldSec'] as const) int(k);

  if (c.confirmMin > c.confirmLookback) out.push({ key: 'confirmMin', message: 'cannot exceed the confirmation lookback' });
  if (c.shortReturnWindowSec >= c.longReturnWindowSec) out.push({ key: 'shortReturnWindowSec', message: 'must be shorter than the long return window' });
  if (c.shortOtmStepsMin > c.shortOtmStepsMax) out.push({ key: 'shortOtmStepsMin', message: 'cannot exceed the maximum' });
  if (c.widthStepsMin > c.widthStepsMax) out.push({ key: 'widthStepsMin', message: 'cannot exceed the maximum' });
  if (c.maxLossPerTrade > c.maxDailyLoss) out.push({ key: 'maxLossPerTrade', message: 'cannot exceed the daily loss limit' });
  if (c.maxConcurrentPositions > 1) out.push({ key: 'maxConcurrentPositions', message: 'Strategy A supports one position at a time' });
  if (c.costModel !== 'FLAT' && c.costModel !== 'DETAILED') out.push({ key: 'costModel', message: 'must be FLAT or DETAILED' });
  return out;
}

/**
 * New user version derived from `base` with `changes` applied. Never mutates
 * `base`. Throws if the result is invalid, so an invalid config can't exist.
 */
export function deriveVersion(base: PulseConfig, changes: Partial<Record<EditableKey, number | string>>, version: number, name?: string): PulseConfig {
  const next: PulseConfig = { ...base };
  for (const [k, v] of Object.entries(changes)) {
    if (!(EDITABLE_KEYS as readonly string[]).includes(k)) throw new Error(`setting ${k} is not editable`);
    (next as any)[k] = v;
  }
  const rootId = base.parentId ?? base.id;
  const derived: PulseConfig = Object.freeze({
    ...next,
    id: `${rootId}-custom`,
    name: name ?? `${base.name.replace(/ \(custom.*\)$/, '')} (custom v${version})`,
    version,
    immutable: false,
    paperOnly: true,
    parentId: rootId,
  });
  const issues = validateConfig(derived);
  if (issues.length) throw new Error(issues.map((i) => `${i.key}: ${i.message}`).join('; '));
  return derived;
}

/** Fields that differ between two configs (for the Settings diff view). */
export function diffConfig(a: PulseConfig, b: PulseConfig): EditableKey[] {
  return EDITABLE_KEYS.filter((k) => a[k] !== b[k]);
}
