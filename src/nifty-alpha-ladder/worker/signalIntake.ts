/**
 * Signal intake: what the worker does when the (unchanged) signal engine
 * fires. Persists the signal idempotently (one row per week key) and sizes
 * it from the configured SHADOW allocation. Does NOT touch G1/G2, signal
 * logic, Variation C or ladder construction — it only consumes a decision.
 *
 * Structure resolution / SHADOW entry simulation is not wired here; this
 * records the signal and the units the allocation affords.
 */
import type { SignalRecord } from '../types.ts';
import type { SignalDecision } from '../signal/signalEngine.ts';
import type { AlphaLadderStore, AlphaLadderSettings } from '../persistence/store.ts';
import { weekIdempotencyKey } from '../calendar/signalCalendar.ts';
import { computeUnitModeUnits } from '../sizing/unitSizing.ts';

type FiredDecision = Extract<SignalDecision, { fired: true }>;

export function toSignalRecord(decision: FiredDecision, signalDateISO: string, nowMs: number): SignalRecord {
  return {
    weekKey: weekIdempotencyKey(new Date(`${signalDateISO}T00:00:00Z`)),
    signalDate: signalDateISO,
    signalInstantSec: decision.signalInstantSec,
    path: decision.path, d1: decision.d1, d2: decision.d2, alpha: decision.alpha,
    baseDirection: decision.baseDirection, finalDirection: decision.finalDirection,
    area1: decision.area1, area2: decision.area2, g1AtSignal: decision.g1AtSignal, g2AtSignal: decision.g2AtSignal,
    crossingTimeSec: decision.crossingTimeSec, crossingG2Value: decision.crossingG2Value,
    vixValue: decision.vixValue, vixAvailable: decision.vixAvailable, variationCActed: decision.variationCActed,
    sourceDataset: 'futures-fallback', createdAtMs: nowMs,
  };
}

export interface SizingOutcome { units: number; note: string }

/** SHADOW-only sizing from the allocation. AUTO is locked: it sizes to zero here no matter what the row says. */
export function sizeFromSettings(settings: AlphaLadderSettings | null): SizingOutcome {
  if (!settings) return { units: 0, note: 'no alpha_ladder_settings row — nothing allocated' };
  if (settings.executionMode !== 'SHADOW') return { units: 0, note: `execution_mode=${settings.executionMode} — AUTO is locked, only SHADOW is sized` };
  const units = settings.sizingMode === 'quantity' ? settings.configuredUnitQuantity : computeUnitModeUnits(settings.allocatedCapital);
  return { units, note: settings.sizingMode === 'quantity'
    ? `quantity mode: ${units} configured unit(s)`
    : `₹${settings.allocatedCapital} allocated -> ${units} unit(s) at ₹340000/unit` };
}

export type IntakeResult = { recorded: boolean; duplicate: boolean; sizing: SizingOutcome };

export async function handleFiredSignal(store: AlphaLadderStore, decision: FiredDecision, signalDateISO: string, nowMs: number): Promise<IntakeResult> {
  const sizing = sizeFromSettings(await store.getSettings());
  const inserted = await store.insertSignal(toSignalRecord(decision, signalDateISO, nowMs));
  if (!inserted.ok) return { recorded: false, duplicate: true, sizing };
  await store.logActivity('info',
    `Signal recorded (SHADOW): direction=${decision.finalDirection}, path=${decision.path}. Sizing: ${sizing.note}.${sizing.units === 0 ? ' Units = 0 — no structure would be opened.' : ''}`,
    { sizing, signalId: inserted.row.id });
  return { recorded: true, duplicate: false, sizing };
}
