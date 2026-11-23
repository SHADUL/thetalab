/**
 * Instrument-master validation and the 150-point ITM contract selector.
 * Shared by the live service and the replay engine, so both select the
 * same contract from the same instrument list. Nothing here is hardcoded:
 * strike interval, lot size and expiries all come from the instrument rows.
 */
import { itmStrike, strikeStep, paise, type Right } from './levels.ts';
import type { ResearchRules } from './rules.ts';

export interface Instrument {
  token: number;
  tradingsymbol: string;
  strike: number;
  right: Right;
  expiry: string;
  lotSize: number;
}

export interface InstrumentReport {
  received: number;
  valid: number;
  expiries: string[];
  lotSizes: Record<string, number>;
  issues: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keeps only rows that are safe to trade from: positive token, finite
 * positive strike, CE/PE, valid expiry not before `today`, positive lot size.
 * Duplicate (expiry, strike, right) rows are removed entirely — an ambiguous
 * contract is never picked. An expiry whose rows disagree on lot size is
 * removed entirely too.
 */
export function validateInstruments(rows: Instrument[], today: string): { valid: Instrument[]; report: InstrumentReport } {
  const issues: string[] = [];
  const ok: Instrument[] = [];
  for (const r of rows) {
    const why = !(Number.isInteger(r.token) && r.token > 0) ? 'non-positive token'
      : !(Number.isFinite(r.strike) && r.strike > 0) ? 'invalid strike'
      : r.right !== 'CE' && r.right !== 'PE' ? 'invalid option right'
      : !DATE.test(r.expiry) ? 'invalid expiry date'
      : r.expiry < today ? 'already expired'
      : !(Number.isInteger(r.lotSize) && r.lotSize > 0) ? 'invalid lot size'
      : null;
    if (why) { issues.push(`${r.tradingsymbol || r.token}: ${why}`); continue; }
    ok.push(r);
  }
  const key = (r: Instrument) => `${r.expiry}|${paise(r.strike)}|${r.right}`;
  const count = new Map<string, number>();
  for (const r of ok) count.set(key(r), (count.get(key(r)) ?? 0) + 1);
  const dupes = [...count].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) issues.push(`${dupes.length} duplicate contract key(s) removed: ${dupes.slice(0, 3).join(', ')}`);
  let valid = ok.filter((r) => count.get(key(r)) === 1);
  const lots = new Map<string, Set<number>>();
  for (const r of valid) { if (!lots.has(r.expiry)) lots.set(r.expiry, new Set()); lots.get(r.expiry)!.add(r.lotSize); }
  for (const [e, s] of lots) if (s.size > 1) { issues.push(`expiry ${e} has mixed lot sizes ${[...s].join('/')} — removed`); valid = valid.filter((r) => r.expiry !== e); }
  const lotSizes: Record<string, number> = {};
  for (const r of valid) lotSizes[r.expiry] = r.lotSize;
  return { valid, report: { received: rows.length, valid: valid.length, expiries: [...new Set(valid.map((r) => r.expiry))].sort(), lotSizes, issues } };
}

export type ContractSelection =
  | { ok: true; instrument: Instrument; strike: number; expiry: string; step: number; itmPoints: number; expiryRolled: boolean }
  | { ok: false; code: 'expiry_missing' | 'contract_missing'; detail: string };

/**
 * Q7: measured from the signal minute's NIFTY close. Q8: an exact halfway
 * tie goes deeper ITM. Q9 (PROVISIONAL, unverified against OptionsBuyer.in):
 * on an expiry day the next listed expiry is used. A missing strike is
 * rejected — never substituted with a different ITM depth.
 */
export function selectContract(instruments: Instrument[], date: string, right: Right, reference: number, rules: ResearchRules): ContractSelection {
  const expiries = [...new Set(instruments.map((i) => i.expiry))].filter((e) => e >= date).sort();
  let expiry = expiries[0];
  let expiryRolled = false;
  if (expiry === date && rules.expiryDayUsesNextExpiry) { expiry = expiries[1]; expiryRolled = true; }
  if (!expiry) return { ok: false, code: 'expiry_missing', detail: expiryRolled ? `expiry day ${date}: no next listed NIFTY expiry` : 'no listed NIFTY expiry on or after today' };
  const chain = instruments.filter((i) => i.expiry === expiry && i.right === right);
  const step = strikeStep(chain.map((i) => i.strike), reference);
  if (step == null) return { ok: false, code: 'contract_missing', detail: `no listed ${right} strikes near ${reference} for ${expiry}` };
  const strike = itmStrike(reference, right, rules.itmPoints, step);
  const inst = chain.find((i) => paise(i.strike) === paise(strike));
  if (!inst) return { ok: false, code: 'contract_missing', detail: `${right} ${strike} (${expiry}) is not in the instrument master` };
  const itm = right === 'CE' ? reference - strike : strike - reference;
  return { ok: true, instrument: inst, strike, expiry, step, itmPoints: Math.round(itm * 100) / 100, expiryRolled };
}
