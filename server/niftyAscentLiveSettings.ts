/**
 * NIFTY ASCENT live-paper settings, editable by the owner from Risk & Settings.
 *
 *  - Stored on the persistent archive disk (no database migration):
 *      <dir>/live-settings.json            the settings for the next session
 *      <dir>/live-settings-log.jsonl       append-only audit of every change
 *      <dir>/live-settings-pinned/<date>.json  what each session actually ran with
 *  - A session's settings are pinned when its engine is created, so a change
 *    never alters a running session (and a mid-day restart restores with the
 *    same settings). Changes apply from the next session not yet started.
 *  - Every value is validated against hard bounds; nothing is raised
 *    automatically. PAPER ONLY — there is no order code behind any setting.
 *  - No file yet ⇒ the defaults are exactly the current live paper settings
 *    (LIVE_PAPER_EXECUTION + LIVE_PAPER_RULES), so behaviour is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_PAPER_EXECUTION, LIVE_PAPER_VARIANT, variantRules, type ExecutionSettings, type RuleVariant } from '../src/nifty-ascent/core/rules.ts';
import type { LiveConfig, LiveConfigPort } from '../src/nifty-ascent/live/service.ts';

/** Editable execution fields and their hard bounds [min, max, integer]. */
export const EXEC_BOUNDS: Record<string, [number, number, boolean]> = {
  paperCapital: [10_000, 1_00_00_000, false],
  lots: [1, 20, true],
  maxPremiumOutlay: [500, 1_00_00_000, false],
  maxTheoreticalLoss: [500, 1_00_00_000, false],
  dailyLossCutoff: [500, 1_00_00_000, false],
  maxQuoteAgeMs: [100, 10_000, true],
  maxSpreadPct: [0.1, 20, false],
  minDailyVolume: [0, 1_00_00_000, true],
  slippage: [0, 0.05, false],
};
const VARIANT_BOUNDS: Record<keyof RuleVariant, [number, number]> = { minOrWidth: [0, 500], rollExpiryWithinDays: [0, 6] };

export interface StoredSettings { exec: ExecutionSettings; variant: RuleVariant; savedAt: string | null; revision: number }

export function validateSettings(input: any, base: StoredSettings): { ok: true; value: StoredSettings } | { ok: false; message: string } {
  const exec: any = { ...base.exec };
  const ei = input?.exec ?? {};
  if (typeof ei !== 'object') return { ok: false, message: 'exec must be an object' };
  for (const [k, v] of Object.entries(ei)) {
    const b = EXEC_BOUNDS[k];
    if (!b) return { ok: false, message: `${k} cannot be changed` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < b[0] || n > b[1] || (b[2] && !Number.isInteger(n))) return { ok: false, message: `${k} must be ${b[2] ? 'a whole number ' : ''}between ${b[0]} and ${b[1]}` };
    exec[k] = n;
  }
  for (const k of ['maxPremiumOutlay', 'maxTheoreticalLoss', 'dailyLossCutoff'] as const) {
    if (exec[k] > exec.paperCapital) return { ok: false, message: `${k} cannot exceed paper capital` };
  }
  const variant: any = { ...base.variant };
  const vi = input?.variant ?? {};
  if (typeof vi !== 'object') return { ok: false, message: 'variant must be an object' };
  for (const [k, v] of Object.entries(vi)) {
    const b = VARIANT_BOUNDS[k as keyof RuleVariant];
    if (!b) return { ok: false, message: `${k} is not a rule filter` };
    const n = Number(v);
    if (!Number.isInteger(n) || n < b[0] || n > b[1]) return { ok: false, message: `${k} must be a whole number between ${b[0]} and ${b[1]}` };
    variant[k] = n;
  }
  const revision = base.revision + 1;
  const sameExec = Object.keys(EXEC_BOUNDS).every((k) => (exec as any)[k] === (base.exec as any)[k]);
  exec.version = sameExec ? base.exec.version : `EXEC-L${revision}`;
  return { ok: true, value: { exec, variant, savedAt: new Date().toISOString(), revision } };
}

export class LiveSettingsStore implements LiveConfigPort {
  private readonly file: string;
  private readonly log: string;
  private readonly pinDir: string;
  private cache: StoredSettings | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, 'live-settings.json');
    this.log = path.join(dir, 'live-settings-log.jsonl');
    this.pinDir = path.join(dir, 'live-settings-pinned');
  }

  /** The stored settings (defaults = current live paper settings when nothing was saved yet). */
  stored(): StoredSettings {
    if (this.cache) return this.cache;
    let s: StoredSettings = { exec: { ...LIVE_PAPER_EXECUTION }, variant: { ...LIVE_PAPER_VARIANT }, savedAt: null, revision: 0 };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const v = validateSettings({ exec: pick(j.exec), variant: j.variant }, s);
      if (v.ok) s = { ...v.value, exec: { ...v.value.exec, version: String(j.exec?.version ?? v.value.exec.version) }, savedAt: j.savedAt ?? null, revision: Number(j.revision) || 0 };
    } catch { /* no file yet → defaults */ }
    this.cache = s;
    return s;
  }

  current(): LiveConfig { const s = this.stored(); return { exec: s.exec, rules: variantRules(s.variant) }; }

  save(input: unknown): { ok: true; value: StoredSettings } | { ok: false; message: string } {
    const before = this.stored();
    const v = validateSettings(input, before);
    if (!v.ok) return v;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v.value, null, 2));
    fs.renameSync(tmp, this.file);
    fs.appendFileSync(this.log, `${JSON.stringify({ at: v.value.savedAt, before: { exec: before.exec, variant: before.variant }, after: { exec: v.value.exec, variant: v.value.variant } })}\n`);
    this.cache = v.value;
    return v;
  }

  pinned(date: string): LiveConfig | null {
    try { return JSON.parse(fs.readFileSync(path.join(this.pinDir, `${safeDate(date)}.json`), 'utf8')); } catch { return null; }
  }

  pin(date: string, cfg: LiveConfig): void {
    fs.mkdirSync(this.pinDir, { recursive: true });
    fs.writeFileSync(path.join(this.pinDir, `${safeDate(date)}.json`), JSON.stringify(cfg));
  }
}

function pick(exec: any) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(EXEC_BOUNDS)) if (exec && k in exec) out[k] = exec[k];
  return out;
}
function safeDate(d: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('bad session date');
  return d;
}
