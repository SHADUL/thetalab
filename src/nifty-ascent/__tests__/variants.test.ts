import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { histReplay, type HistDay, type MinuteCandle } from '../sim/historical.ts';
import { selectContract } from '../core/contracts.ts';
import { RESEARCH_RULES_V1 as V1, NO_VARIANT, variantRules } from '../core/rules.ts';
import { instruments as mkInst } from './helpers.ts';

/** Gap up, OR 25,190–25,230 (width 40), upside breakout at 10:00. */
function day(): HistDay {
  const bars: MinuteCandle[] = [];
  for (let m = 555; m <= 929; m++) {
    const c = m < 560 ? 25200 : m < 570 ? 25230 : m < 600 ? 25190 : 25260;
    const prev = bars.length ? bars[bars.length - 1].c : 25200;
    bars.push({ label: m, o: m === 555 ? 25200 : prev, h: Math.max(prev, c) + 2, l: Math.min(prev, c) - 2, c });
  }
  const prevBars = Array.from({ length: 375 }, (_, i) => ({ label: 555 + i, close: i === 360 ? 25100 : i === 100 ? 25260 : i === 200 ? 25010 : 25120 }));
  return { kind: 'NIFTY_ASCENT_HIST_DAY', date: '2026-11-18', prevDate: '2026-11-17', bars, prevBars, vixPrevClose: 12, expiries: ['2026-11-24', '2026-12-01'], lotSize: 65, strikeStep: 50, source: 'KITE_HISTORICAL', fetchedAt: '' };
}

test('variant: nothing switched on returns the locked V1 object; V1 carries no variant fields', () => {
  assert.equal(variantRules(NO_VARIANT), V1);
  assert.equal(variantRules({ minOrWidth: -5, rollExpiryWithinDays: 0 }), V1);
  assert.equal(V1.minOrWidth, undefined); assert.equal(V1.rollExpiryWithinDays, undefined);
  assert.ok(Object.isFrozen(V1));
  const v = variantRules({ minOrWidth: 60, rollExpiryWithinDays: 1 });
  assert.equal(v.version, 'NIFTY_ASCENT_V1.0+OR60+ROLL1');
  assert.deepEqual({ ...v, version: V1.version, minOrWidth: undefined, rollExpiryWithinDays: undefined }, { ...V1, minOrWidth: undefined, rollExpiryWithinDays: undefined });
});

test('variant: a narrow opening range skips the whole day; a wide-enough one trades as V1', () => {
  const base = histReplay(day()).runToEnd();
  assert.equal(base.or!.width, 40);
  assert.equal(base.signal?.bot, 'GAP_AND_GO');
  const skip = histReplay(day(), { rules: variantRules({ minOrWidth: 50, rollExpiryWithinDays: 0 }) }).runToEnd();
  assert.deepEqual([skip.outcome?.kind, skip.outcome?.reason, skip.signal, skip.trade], ['NO_TRADE', 'narrow_or', null, null]);
  assert.ok(skip.configVersion.includes('+OR50'));
  const keep = histReplay(day(), { rules: variantRules({ minOrWidth: 40, rollExpiryWithinDays: 0 }) }).runToEnd();
  assert.equal(JSON.stringify(keep.trade), JSON.stringify(base.trade));
});

test('variant: 1-day-to-expiry rolls to the next listed expiry; further out and V1 do not', () => {
  const inst = mkInst(['2026-11-24', '2026-12-01']);
  const roll = variantRules({ minOrWidth: 0, rollExpiryWithinDays: 1 });
  const mon = selectContract(inst, '2026-11-23', 'CE', 25300, roll);
  assert.ok(mon.ok && mon.expiry === '2026-12-01' && mon.expiryRolled);
  const v1 = selectContract(inst, '2026-11-23', 'CE', 25300, V1);
  assert.ok(v1.ok && v1.expiry === '2026-11-24' && !v1.expiryRolled);
  const wed = selectContract(inst, '2026-11-18', 'CE', 25300, roll);
  assert.ok(wed.ok && wed.expiry === '2026-11-24' && !wed.expiryRolled);
  assert.ok(!selectContract(mkInst(['2026-11-24']), '2026-11-23', 'CE', 25300, roll).ok, 'no next expiry → rejected, never substituted');
});

test('variant: live paper code never references the backtest-only variant', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const files = ['server/niftyAscent.ts', ...readdirSync(path.join(root, 'src/nifty-ascent/live')).filter((f) => f.endsWith('.ts')).map((f) => `src/nifty-ascent/live/${f}`)];
  for (const f of files) assert.ok(!/variantRules|minOrWidth|rollExpiryWithinDays/.test(readFileSync(path.join(root, f), 'utf8')), f);
});
