/**
 * LIVE ORDERS — owner arm switch and per-strategy live limits.
 * Arming needs the typed confirmation phrase; the server must also run with
 * LIVE_ORDERS=on. Disarmed (the default) ⇒ no new real entry is ever sent;
 * an open real position is still managed until it is closed.
 */
import type { Strategy } from './runner.ts';

export const ARM_PHRASE = 'ARM LIVE';

/** [min, max, default, integer] */
export const LIVE_SETTINGS_SPEC: Record<Strategy, Record<string, [number, number, number, boolean]>> = {
  // Mirrors live paper exactly (same engine, contract, size and risk limits). Only the crash-guard distance is live-specific.
  NIFTY_ASCENT: { stopBufferPct: [0, 20, 5, false] },
  NAKED_SELL: {
    lots: [1, 5, 1, true],
    maxEntriesPerDay: [1, 10, 2, true],
    maxDailyLoss: [500, 1_00_000, 5_000, false],
    stopBufferPct: [0, 50, 5, false],
  },
};

export interface LiveControlState { strategy: Strategy; armed: boolean; armedAt: string | null; settings: Record<string, number>; updatedAt: string | null }

export function defaultControl(strategy: Strategy): LiveControlState {
  return { strategy, armed: false, armedAt: null, settings: Object.fromEntries(Object.entries(LIVE_SETTINGS_SPEC[strategy]).map(([k, v]) => [k, v[2]])), updatedAt: null };
}

export function validateLiveSettings(strategy: Strategy, input: unknown, base: Record<string, number>): { ok: true; value: Record<string, number> } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') return { ok: false, message: 'settings must be an object' };
  const spec = LIVE_SETTINGS_SPEC[strategy];
  const out = { ...base };
  for (const [k, v] of Object.entries(input)) {
    const s = spec[k];
    if (!s) return { ok: false, message: `${k} is not a live setting` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < s[0] || n > s[1] || (s[3] && !Number.isInteger(n))) return { ok: false, message: `${k} must be ${s[3] ? 'a whole number ' : ''}between ${s[0]} and ${s[1]}` };
    out[k] = n;
  }
  return { ok: true, value: out };
}

export interface LiveControlPort {
  load(strategy: Strategy): Promise<LiveControlState>;
  save(strategy: Strategy, patch: Partial<Pick<LiveControlState, 'armed' | 'armedAt' | 'settings'>>): Promise<LiveControlState>;
}

export class MemoryLiveControl implements LiveControlPort {
  rows = new Map<Strategy, LiveControlState>();
  async load(s: Strategy) { return JSON.parse(JSON.stringify(this.rows.get(s) ?? defaultControl(s))); }
  async save(s: Strategy, patch: Partial<LiveControlState>) {
    const next = { ...(this.rows.get(s) ?? defaultControl(s)), ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(s, next);
    return JSON.parse(JSON.stringify(next));
  }
}
