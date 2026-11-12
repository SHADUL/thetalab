import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intradayTrend, completedBars, sideForTrend, trendAgainst, pickStrike, liquidityProblems, entryFill, exitFill,
  levels, checkExit, roundTripCharges, shortPnl, entryBlocker, istMinuteOf, DEFAULT_SETTINGS, type Candle, type OptionQuote,
} from '../engine.ts';
import { black76 } from '../../quant/pricing/black76.ts';

function bars(closes: number[]): Candle[] {
  const t0 = Date.parse('2026-11-12T03:45:00Z'); // 09:15 IST
  return closes.map((c, i) => ({ t: new Date(t0 + i * 300_000).toISOString(), o: c, h: c + 2, l: c - 2, c }));
}

test('intradayTrend: rising session is BULLISH, falling is BEARISH, chop is NEUTRAL', () => {
  const up = intradayTrend(bars(Array.from({ length: 12 }, (_, i) => 24000 + i * 8)));
  assert.equal(up.state, 'BULLISH');
  const down = intradayTrend(bars(Array.from({ length: 12 }, (_, i) => 24000 - i * 8)));
  assert.equal(down.state, 'BEARISH');
  const chop = intradayTrend(bars([24000, 24004, 23998, 24003, 23999, 24002, 24000, 24001]));
  assert.equal(chop.state, 'NEUTRAL');
});

test('intradayTrend: needs 6 completed bars', () => {
  const r = intradayTrend(bars([1, 2, 3, 4, 5]));
  assert.equal(r.state, 'NEUTRAL');
  assert.match(r.reason, /only 5/);
});

test('intradayTrend: pullback below EMA9 in an uptrend is NEUTRAL, not BULLISH', () => {
  const closes = [...Array.from({ length: 12 }, (_, i) => 24000 + i * 10), 24050];
  assert.equal(intradayTrend(bars(closes)).state, 'NEUTRAL');
});

test('completedBars drops the forming candle', () => {
  const b = bars([1, 2, 3]);
  const now = Date.parse(b[2].t) + 120_000; // 2 min into the 3rd bar
  assert.equal(completedBars(b, now).length, 2);
});

test('side mapping and trend-against', () => {
  assert.equal(sideForTrend('BULLISH'), 'PE');
  assert.equal(sideForTrend('BEARISH'), 'CE');
  assert.equal(sideForTrend('NEUTRAL'), null);
  assert.ok(trendAgainst('PE', 'BEARISH'));
  assert.ok(!trendAgainst('PE', 'NEUTRAL'));
  assert.ok(trendAgainst('CE', 'BULLISH'));
});

test('pickStrike chooses the OTM strike nearest 0.30 delta', () => {
  const spot = 24000, expiry = '2026-11-17';
  const now = Date.parse('2026-11-12T05:00:00Z');
  const T = (Date.parse(`${expiry}T15:30:00+05:30`) - now) / (365 * 86_400_000);
  const F = spot * Math.exp(0.065 * T);
  const quotes: OptionQuote[] = [];
  for (let k = 23500; k <= 24000; k += 50) {
    const px = black76({ forward: F, strike: k, timeToExpiry: T, vol: 0.14, rate: 0.065, right: 'PE' }).price;
    quotes.push({ strike: k, right: 'PE', tradingsymbol: `N${k}PE`, bid: px - 0.5, ask: px + 0.5, last: px, volume: 5000, oi: 1 });
  }
  const pick = pickStrike(quotes, 'PE', spot, expiry, now, 0.3)!;
  assert.ok(pick);
  assert.ok(pick.quote.strike < spot);
  assert.ok(Math.abs(pick.delta - 0.3) < 0.06, `delta ${pick.delta}`);
  // every other OTM strike is at least as far from 0.30
  assert.ok(Math.abs(pick.iv - 0.14) < 0.01);
});

test('liquidityProblems flags wide spread and zero volume', () => {
  const q = { strike: 1, right: 'PE' as const, tradingsymbol: 'x', bid: 10, ask: 12, last: 11, volume: 0, oi: 0 };
  const p = liquidityProblems(q, 5, 100)!;
  assert.equal(p.length, 2);
  assert.equal(liquidityProblems({ ...q, bid: 10, ask: 10.2, volume: 500 }, 5, 100), null);
});

test('fills: PAPER mid, SHADOW bid on entry and ask on exit', () => {
  const q = { strike: 1, right: 'CE' as const, tradingsymbol: 'x', bid: 50, ask: 52, last: 51, volume: 1, oi: 1 };
  assert.equal(entryFill('PAPER', q), 51);
  assert.equal(entryFill('SHADOW', q), 50);
  assert.equal(exitFill('PAPER', q), 51);
  assert.equal(exitFill('SHADOW', q), 52);
});

test('levels: TP at 40% decay, SL at 30% rise', () => {
  assert.deepEqual(levels(60, 40, 30), { tp: 36, sl: 78 });
});

test('checkExit priority: SL > SQUARE_OFF > TP > TREND_FLIP', () => {
  const p = { right: 'PE' as const, tp_price: 36, sl_price: 78 };
  assert.equal(checkExit(p, 80, 'BEARISH', 920, 915).reason, 'SL');
  assert.equal(checkExit(p, 50, 'BULLISH', 915, 915).reason, 'SQUARE_OFF');
  assert.equal(checkExit(p, 35, 'BEARISH', 700, 915).reason, 'TP');
  assert.equal(checkExit(p, 50, 'BEARISH', 700, 915).reason, 'TREND_FLIP');
  assert.equal(checkExit(p, 50, 'NEUTRAL', 700, 915).exit, false);
  assert.equal(checkExit(p, null, 'BULLISH', 700, 915).exit, false);
});

test('charges and P&L for a short', () => {
  assert.equal(shortPnl(60, 36, 75), 1800);
  assert.equal(shortPnl(60, 78, 75), -1350);
  const c = roundTripCharges(60, 36, 75, 'NFO');
  assert.ok(c > 40 && c < 70, `charges ${c}`);
});

test('entryBlocker covers window, expiry day, caps, loss limit and cooldown', () => {
  const ok = { minuteIst: 600, isExpiryDay: false, hasOpenPosition: false, entriesToday: 0, realizedToday: 0, minutesSinceLastExit: null };
  assert.equal(entryBlocker(DEFAULT_SETTINGS, ok), null);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, minuteIst: 580 })!, /before/);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, minuteIst: 880 })!, /after/);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, isExpiryDay: true })!, /expiry/);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, hasOpenPosition: true })!, /open/);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, entriesToday: 2 })!, /max 2/);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, realizedToday: -5000 })!, /loss limit/);
  assert.match(entryBlocker(DEFAULT_SETTINGS, { ...ok, minutesSinceLastExit: 5 })!, /cooldown/);
});

test('istMinuteOf converts UTC to IST minutes', () => {
  assert.equal(istMinuteOf(Date.parse('2026-11-12T04:15:00Z')), 585);
});
