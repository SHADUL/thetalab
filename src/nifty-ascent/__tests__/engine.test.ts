import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D, at, prevBars, instruments, engine, steps, drive, defaultQuote, GAP_UP_OR, GAP_DOWN_OR, type QuoteFn } from './helpers.ts';
import { barLabelOf, hhmm } from '../core/rules.ts';

const run = (pts: Array<[string, number]>, o: Parameters<typeof engine>[0] & { quote?: QuoteFn; to?: string } = {}) =>
  drive(engine(o), { date: o.date, index: steps(o.date ?? D, pts), quote: o.quote, to: o.to });
const transitions = (e: ReturnType<typeof engine>) => e.events.filter((x) => x.kind === 'TRANSITION').map((x) => x.to);

/* ---------------- Q1 / Q2: reference and bar conventions ---------------- */

test('Q1: today_open is the first valid tick at or after 09:15:00 (earlier ticks ignored)', () => {
  const e = engine();
  e.onIndexTick({ exchTs: at(D, '09:14:59'), recvTs: at(D, '09:14:59') + 100, price: 25999 });
  e.onIndexTick({ exchTs: at(D, '09:15:00'), recvTs: at(D, '09:15:00') + 100, price: 25200 });
  e.onIndexTick({ exchTs: at(D, '09:15:01'), recvTs: at(D, '09:15:01') + 100, price: 25210 });
  assert.equal(e.reference!.price, 25200);
  assert.equal(e.gap!.points, 100);
});

test('Q2: previous close is the close of the bar LABELLED 15:15, not 15:14', () => {
  const e = engine({ prev: prevBars({ close1515: 25100, close1514: 25050 }) });
  assert.equal(e.prevClose, 25100);
  const bad = engine({ prev: prevBars({ drop: [915] }) });
  assert.equal(bad.state, 'DATA_ERROR');
  assert.equal(bad.outcome!.reason, 'data_error');
});

test('Q2: opening range = bars 09:15…09:45, finalised only after 09:46:00 + grace; 09:46 excluded', () => {
  const e = engine();
  const idx = steps(D, [...GAP_UP_OR, ['09:45:30', 25300], ['09:46', 25100]]);
  drive(e, { index: idx, to: '09:46:01' });
  assert.equal(e.or, null, 'not before 09:46:01.5');
  drive(e, { index: idx, from: '09:46:02', to: '09:46:02' });
  assert.equal(e.or!.closes.length, 31);
  assert.equal(e.or!.high, 25300); // 09:45 close (bar 09:45 ends at 25,300)
  assert.equal(e.or!.low, 25180);  // the 09:46 dip to 25,100 is not in the range
});

/* ---------------- Gap-and-Go ---------------- */

test('Gap-and-Go CE: strict close beyond the upside band; touching the band is not a breakout', () => {
  const touch = run([...GAP_UP_OR, ['09:50', 25235], ['12:30', 25200]]);
  assert.equal(touch.outcome!.reason, 'no_break');
  const e = run([...GAP_UP_OR, ['09:50', 25235], ['10:00', 25235.05], ['10:01', 25260]]);
  assert.equal(e.signal!.bot, 'GAP_AND_GO');
  assert.equal(e.signal!.right, 'CE');
  assert.equal(hhmm(e.signal!.bar), '10:00');
  assert.equal(e.trade?.bot ?? e.position?.bot, 'GAP_AND_GO');
});

test('Gap-and-Go PE on a gap-down day; an upside break on a gap-down day is opposite_first, never a CE', () => {
  const pe = run([...GAP_DOWN_OR, ['10:10', 24970]]);
  assert.equal(pe.signal!.right, 'PE');
  const opp = run([...GAP_DOWN_OR, ['10:10', 25040]]);
  assert.equal(opp.standDown!.reason, 'opposite_first');
  assert.notEqual(opp.signal?.bot, 'GAP_AND_GO');
});

test('no signal outside 09:46–12:00: a 12:01 breakout is ignored → no_break at 12:00', () => {
  const e = run([...GAP_UP_OR, ['12:01', 25300]]);
  assert.equal(e.standDown!.reason, 'no_break');
  assert.equal(hhmm(e.standDown!.bar), '12:00');
  assert.equal(e.signal, null);
});

test('opposite_first: recorded with its bar and close; gap direction never flips', () => {
  const e = run([...GAP_UP_OR, ['10:05', 25170], ['10:30', 25300]]);
  assert.equal(e.standDown!.reason, 'opposite_first');
  assert.equal(hhmm(e.standDown!.bar), '10:05');
  assert.equal(e.standDown!.close, 25170);
  assert.equal(e.gap!.direction, 'UP');
});

/* ---------------- Q3: tick-based gap fill, no look-ahead ---------------- */

test('Q3: an intrabar TICK at the previous close fills the gap even though no minute closes there', () => {
  const e = run([...GAP_UP_OR, ['10:00:00', 25200], ['10:00:20', 25100], ['10:00:21', 25200], ['10:30', 25240]]);
  assert.equal(e.gapFill!.price, 25100);
  assert.equal(e.standDown!.reason, 'filled');
  assert.equal(hhmm(e.standDown!.bar), '10:30');
});

test('Q3: a fill tick AFTER the breakout bar is not used (no look-ahead)', () => {
  const e = run([...GAP_UP_OR, ['10:30', 25240], ['10:31:10', 25090], ['10:31:20', 25240]]);
  assert.equal(e.signal!.bot, 'GAP_AND_GO');
  assert.equal(hhmm(e.signal!.bar), '10:30');
  assert.ok(e.gapFill && e.gapFill.exchTs > at(D, '10:30:59'));
});

test('Q3: gap-down fill = tick at or ABOVE the previous close', () => {
  const e = run([...GAP_DOWN_OR, ['10:00:00', 25000], ['10:00:10', 25100], ['10:00:11', 25000], ['10:20', 24960]]);
  assert.equal(e.standDown!.reason, 'filled');
});

/* ---------------- Q4 ---------------- */

test('Q4: gap filled but no breakout by 12:00 → no_break, Williams never activates', () => {
  // Williams PE would be 25,200 − 125 = 25,075; NIFTY later trades far below it.
  const e = run([...GAP_UP_OR, ['10:00:00', 25200], ['10:00:20', 25100], ['10:00:21', 25200], ['12:30', 24900]]);
  assert.ok(e.gapFill);
  assert.equal(e.outcome!.reason, 'no_break');
  assert.ok(!transitions(e).includes('WILLIAMS_ARMED'));
  assert.equal(e.signal, null);
});

/* ---------------- Q5 ---------------- */

test('Q5: a missing opening-range minute → DATA_ERROR, no trade', () => {
  const e = engine();
  const idx = steps(D, [...GAP_UP_OR, ['10:00', 25300]]);
  drive(e, { index: (t) => (barLabelOf(D, t) === 9 * 60 + 31 ? null : idx(t)) });
  assert.equal(e.state, 'DATA_ERROR');
  assert.match(e.outcome!.detail!, /09:31/);
  assert.equal(e.positionsToday, 0);
});

test('Q5: previous day with too few Kite bars → DATA_ERROR before the open', () => {
  const e = engine({ prev: prevBars({ drop: Array.from({ length: 10 }, (_, i) => 600 + i) }) });
  assert.equal(e.state, 'DATA_ERROR');
});

/* ---------------- Williams ---------------- */

test('Williams after opposite_first: eligible gap (<0.2%), first level to break wins, regardless of GG direction', () => {
  // prev 25,100 → open 25,140 (0.159%); OR 25,120–25,160 → down band 25,116; Williams CE 25,265 / PE 25,015.
  const e = run([['09:15:00', 25140], ['09:20', 25160], ['09:30', 25120], ['10:05', 25110], ['11:00', 25270]]);
  assert.equal(e.standDown!.reason, 'opposite_first');
  assert.equal(e.signal!.bot, 'WILLIAMS');
  assert.equal(e.signal!.right, 'CE');
  assert.equal(hhmm(e.signal!.bar), '11:00');
});

test('Williams is ineligible for a gap in [0.2%, 0.5%)', () => {
  const e = run([['09:15:00', 25175], ['09:20', 25195], ['09:30', 25160], ['10:05', 25150], ['11:00', 24900]]);
  assert.equal(e.standDown!.reason, 'opposite_first');
  assert.equal(e.outcome!.reason, 'williams_gap_ineligible');
  assert.ok(!transitions(e).includes('WILLIAMS_ARMED'));
});

test('Williams cutoff: a first break at 14:30 is ignored → williams_no_trigger', () => {
  const e = run([['09:15:00', 25140], ['09:20', 25160], ['09:30', 25120], ['10:05', 25110], ['14:30', 25300]]);
  assert.equal(e.outcome!.reason, 'williams_no_trigger');
  assert.equal(e.signal, null);
});

test('Williams 14:29 is still inside the window', () => {
  const e = run([['09:15:00', 25140], ['09:20', 25160], ['09:30', 25120], ['10:05', 25110], ['14:29', 25300]]);
  assert.equal(hhmm(e.signal!.bar), '14:29');
});

test('Q15: Williams evaluates the SAME bar that caused the handover (GG stand-down processed first)', () => {
  const e = run([['09:15:00', 25140], ['09:20', 25160], ['09:30', 25120], ['10:05', 25000]]);
  const t = transitions(e);
  assert.deepEqual(t.slice(t.indexOf('GAP_GO_STOOD_DOWN'), t.indexOf('WILLIAMS_SIGNALLED') + 1),
    ['GAP_GO_STOOD_DOWN', 'WILLIAMS_ELIGIBILITY_CHECK', 'WILLIAMS_ARMED', 'WILLIAMS_SIGNALLED']);
  assert.equal(e.signal!.bar, e.standDown!.bar);
  assert.equal(e.signal!.right, 'PE');
});

test('Williams never evaluates bars before the handover', () => {
  // Before the handover NIFTY already traded above the CE level (25,265) — that must not count.
  const e = run([['09:15:00', 25140], ['09:20', 25160], ['09:30', 25120], ['09:47', 25150], ['10:05', 25110], ['10:06', 25150]]);
  assert.ok(e.williams!.ceLevel > 25150);
  assert.equal(e.signal, null);
});

/* ---------------- Q9 ---------------- */

test('Q9: on expiry day the next listed expiry is used; otherwise the nearest', () => {
  const tue = run([...GAP_UP_OR, ['10:00', 25260]], { date: '2026-11-24', prev: prevBars(), inst: instruments(['2026-11-24', '2026-12-01']) });
  assert.equal(tue.trade!.expiry, '2026-12-01');
  const wed = run([...GAP_UP_OR, ['10:00', 25260]]);
  assert.equal(wed.trade!.expiry, '2026-11-24');
});

/* ---------------- Q10: entry fills ---------------- */

test('Q10: entry fills at the first FRESH executable ask in the next minute (+0.25% slippage), never the signal close', () => {
  const e = run([...GAP_UP_OR, ['10:00', 25260]], { to: '10:03:00' });
  const o = e.entryOrder!;
  assert.equal(o.status, 'FILLED');
  assert.equal(barLabelOf(D, o.fill!.quoteExchTs), 10 * 60 + 1);
  assert.equal(o.fill!.price, Math.round(o.fill!.quoteAsk * 1.0025 * 100) / 100);
  assert.notEqual(o.fill!.price, e.signal!.close);
  assert.ok(o.fill!.quoteAgeMs <= 2000);
});

test('Q10: stale and wide quotes are skipped; no executable ask in the next minute → entry rejected, day over', () => {
  const stale: QuoteFn = (i, t, s) => ({ ...defaultQuote(i, t, s)! });
  const e = engine();
  const idx = steps(D, [...GAP_UP_OR, ['10:00', 25260]]);
  // Deliver quotes with exchange time 3 s old (stale) during 10:01, wide afterwards.
  const byTok = new Map(e.instruments.map((i) => [i.token, i]));
  for (let t = at(D, '09:14:00'); t <= at(D, '15:31:00'); t += 1000) {
    e.onClock(t);
    if (t >= at(D, '09:15:00') && t < at(D, '15:30:00')) e.onIndexTick({ exchTs: t, recvTs: t + 150, price: idx(t)! });
    for (const tok of e.wantedTokens()) {
      const q = stale(byTok.get(tok)!, t, idx(t))!;
      e.onOptionTick({ token: tok, exchTs: t - 3000, recvTs: t + 100, ...q });
    }
  }
  assert.equal(e.entryOrder!.status, 'REJECTED');
  assert.ok((e.entryOrder!.skipped.stale_quote ?? 0) > 0);
  assert.equal(e.positionsToday, 0);
  assert.equal(e.outcome!.reason, 'entry_rejected');
  assert.ok(e.events.some((x) => x.trigger === 'entry_no_executable_quote'));
});

test('liquidity gates: spread > 1.5% of mid and volume < 500 are not executable', () => {
  const wide: QuoteFn = (i, t, s) => { const q = defaultQuote(i, t, s)!; return { ...q, bid: q.ltp! - 3, ask: q.ltp! + 3 }; };
  const e = run([...GAP_UP_OR, ['10:00', 25260]], { quote: wide });
  assert.ok((e.entryOrder!.skipped.spread_too_wide ?? 0) > 0);
  assert.equal(e.entryOrder!.status, 'REJECTED');
  const thin: QuoteFn = (i, t, s) => ({ ...defaultQuote(i, t, s)!, volume: 499 });
  const e2 = run([...GAP_UP_OR, ['10:00', 25260]], { quote: thin });
  assert.ok((e2.entryOrder!.skipped.low_volume ?? 0) > 0);
});

/* ---------------- Q13: budget ---------------- */

test('Q13: one lot over ₹15,000 INCLUDING estimated fees is rejected; strike/quantity are never changed', () => {
  // Premium fixed so that price × 65 ≈ ₹14,985 (< ₹15,000) but + fees > ₹15,000.
  // ask 229.90 → fill 230.47 → ₹14,980.55 premium; + ~₹25.6 entry fees = ₹15,006 > ₹15,000.
  const pricey: QuoteFn = () => ({ ltp: 229.9, traded: true, bid: 229.65, ask: 229.9, volume: 50_000 });
  const e = run([...GAP_UP_OR, ['10:00', 25260]], { quote: pricey });
  assert.ok(e.entryOrder!.fill == null);
  assert.equal(e.entryOrder!.rejectReason, 'budget');
  assert.equal(e.positionsToday, 0);
  const fits: QuoteFn = () => ({ ltp: 228, traded: true, bid: 227.75, ask: 228, volume: 50_000 });
  const ok = run([...GAP_UP_OR, ['10:00', 25260]], { quote: fits, to: '10:02:00' });
  assert.equal(ok.entryOrder!.status, 'FILLED');
  assert.equal(ok.position!.qty, 65);
});

/* ---------------- Q6 / exits ---------------- */

/** Premium script by minute after a CE entry at the default ~ask. */
function premiumPath(path: Array<[string, number]>, noPrint: string[] = []): QuoteFn {
  const f = steps(D, path);
  return (inst, t) => {
    const p = f(t) ?? 200;
    const hm = hhmm(barLabelOf(D, t));
    return { ltp: noPrint.includes(hm) ? null : p, traded: !noPrint.includes(hm), bid: p - 0.25, ask: p + 0.25, volume: 50_000 };
  };
}
const CE_DAY: Array<[string, number]> = [...GAP_UP_OR, ['10:00', 25260]];

test('fixed stop: premium close ≤ 70% of entry → exit signal; next-minute bid fill (can be worse than the threshold)', () => {
  const q = premiumPath([['09:00', 200], ['10:20', 141], ['10:30', 140], ['10:31', 120]]);
  const e = run(CE_DAY, { quote: q });
  const entry = e.trade!.entryPremium;
  assert.equal(e.trade!.exitReason, 'FIXED_STOP');
  assert.ok(140 <= entry * 0.7);
  assert.equal(hhmm(e.trade!.exitSignalBar!), '10:30');
  assert.ok(e.trade!.exitPremium < entry * 0.7 - 15, 'gap-through fill reflected, not the threshold');
});

test('trail: exactly 105% does NOT activate; strictly above does; 20% off the highest close exits', () => {
  // Zero slippage and ask 200.00 → entry exactly ₹200.00, so 105% is exactly ₹210.00.
  const noAct = run(CE_DAY, { exec: { slippage: 0 }, quote: premiumPath([['09:00', 199.75], ['10:10', 210], ['10:40', 150], ['15:30', 150]]) });
  assert.equal(noAct.trade!.entryPremium, 200);
  assert.equal(noAct.trade!.trailActivated, false);
  assert.equal(noAct.trade!.exitReason, 'TIME_EXIT', '150 > 140 fixed stop and the trail never armed');
  const justAbove = run(CE_DAY, { exec: { slippage: 0 }, quote: premiumPath([['09:00', 199.75], ['10:10', 210.05]]) });
  assert.equal(justAbove.trade!.trailActivated, true);
  const exactStop = run(CE_DAY, { exec: { slippage: 0 }, quote: premiumPath([['09:00', 199.75], ['10:10', 140]]) });
  assert.equal(exactStop.trade!.exitReason, 'FIXED_STOP', 'exactly 70% triggers');

  const act = run(CE_DAY, { quote: premiumPath([['09:00', 200], ['10:10', 250], ['10:20', 260], ['10:40', 208.5], ['10:45', 208]]) });
  assert.equal(act.trade!.trailActivated, true);
  assert.equal(act.trade!.highest, 260);
  assert.equal(act.trade!.exitReason, 'TRAILING_STOP');
  assert.equal(hhmm(act.trade!.exitSignalBar!), '10:45'); // 208 ≤ 0.8 × 260 = 208; 208.5 is not
});

test('both stops on the same close → FIXED_STOP, both triggers recorded', () => {
  const e = run(CE_DAY, { quote: premiumPath([['09:00', 200], ['10:10', 215], ['10:30', 130]]) });
  assert.equal(e.trade!.exitReason, 'FIXED_STOP');
  const ev = e.events.find((x) => x.kind === 'STOP' && x.trigger === 'fixed_stop')!;
  assert.match(ev.reason, /both triggered/);
});

test('Q6: a NO_PRINT minute never triggers a stop, even if bid/ask collapse', () => {
  const q: QuoteFn = (inst, t) => {
    const hm = hhmm(barLabelOf(D, t));
    if (hm === '10:30') return { ltp: null, traded: false, bid: 50, ask: 51, volume: 50_000 };
    return { ltp: 200, traded: true, bid: 199.75, ask: 200.25, volume: 50_000 };
  };
  const e = run(CE_DAY, { quote: q });
  assert.equal(e.trade!.exitReason, 'TIME_EXIT');
  assert.ok(e.events.some((x) => x.trigger === 'no_print' && hhmm(x.bar!) === '10:30'));
});

test('Q11: time exit initiated at 15:15:00 and filled at the first fresh bid at/after 15:15:00', () => {
  const e = run(CE_DAY, { quote: premiumPath([['09:00', 200]]) });
  assert.equal(e.trade!.exitReason, 'TIME_EXIT');
  assert.ok(e.exitOrder!.fill!.quoteExchTs >= at(D, '15:15:00'));
  assert.ok(e.exitOrder!.fill!.quoteExchTs < at(D, '15:15:02'));
  assert.equal(e.position, null, 'no overnight position');
});

test('Q11: no valid bid after 15:15 → no fabricated fill, UNRESOLVED_EXIT', () => {
  const q: QuoteFn = (i, t, s) => (t >= at(D, '15:15:00') ? { ltp: null, traded: false, bid: null, ask: null, volume: 50_000 } : defaultQuote(i, t, s));
  const e = run(CE_DAY, { quote: q });
  assert.equal(e.trade, null);
  assert.equal(e.outcome!.kind, 'UNRESOLVED_EXIT');
  assert.equal(e.exitOrder!.status, 'UNRESOLVED');
});

/* ---------------- Q12: controls ---------------- */

test('Q12: STOP NEW ENTRIES keeps managing the open position; signals while stopped are not traded', () => {
  const e = engine();
  drive(e, { index: steps(D, CE_DAY), onSecond: (t) => { if (t === at(D, '10:05:00')) e.control('STOP_ENTRIES', t); } });
  assert.equal(e.trade!.exitReason, 'TIME_EXIT');
  const e2 = engine();
  drive(e2, { index: steps(D, CE_DAY), onSecond: (t) => { if (t === at(D, '09:50:00')) e2.control('STOP_ENTRIES', t); } });
  assert.equal(e2.positionsToday, 0);
  assert.equal(e2.outcome!.reason, 'entry_rejected');
});

test('Q12: KILL / FLATTEN blocks entries and closes at a fresh bid; START refused until released', () => {
  const e = engine();
  drive(e, { index: steps(D, CE_DAY), onSecond: (t) => { if (t === at(D, '11:00:00')) e.control('KILL', t); } });
  assert.equal(e.trade!.exitReason, 'KILL_FLATTEN');
  assert.ok(e.exitOrder!.fill!.quoteExchTs >= at(D, '11:00:00'));
  e.control('START', at(D, '11:05:00'));
  assert.equal(e.engineStatus, 'KILLED');
});

test('engine starts PAUSED by default: signals are recorded but never entered', () => {
  const e = run(CE_DAY, { running: false });
  assert.ok(e.signal);
  assert.equal(e.positionsToday, 0);
  assert.ok(e.events.some((x) => x.trigger === 'entries_disabled'));
});

/* ---------------- one position per day ---------------- */

test('one position per day: no re-entry after a stop, after a profitable exit, or across bots', () => {
  const stopped = run([...CE_DAY, ['10:40', 25150], ['11:00', 25300]], { quote: premiumPath([['09:00', 200], ['10:30', 130], ['11:00', 260]]) });
  assert.equal(stopped.positionsToday, 1);
  assert.equal(stopped.events.filter((x) => x.kind === 'FILL' && x.trigger === 'entry_fill').length, 1);
  const won = run(CE_DAY, { quote: premiumPath([['09:00', 200], ['10:10', 260], ['10:30', 200]]) });
  assert.equal(won.trade!.exitReason, 'TRAILING_STOP');
  assert.equal(won.events.filter((x) => x.kind === 'ORDER' && x.trigger === 'entry_order').length, 1);
});

test('repeated quotes after a fill never create a second entry', () => {
  const e = run(CE_DAY, { to: '10:05:00' });
  const fills = e.events.filter((x) => x.kind === 'FILL' && x.trigger === 'entry_fill').length;
  for (let k = 0; k < 20; k++) e.onOptionTick({ token: e.position!.instrument.token, exchTs: at(D, '10:05:00') + k, recvTs: at(D, '10:05:00') + k + 50, ltp: 200, traded: true, bid: 199.75, ask: 200.25, volume: 1e5 });
  assert.equal(e.events.filter((x) => x.kind === 'FILL' && x.trigger === 'entry_fill').length, fills);
  assert.equal(e.positionsToday, 1);
});

/* ---------------- Q14 ---------------- */

test('Q14: zero gap → no Gap-and-Go direction, no Williams, no trade', () => {
  const e = run([['09:15:00', 25100], ['09:30', 25150], ['10:30', 25400], ['11:00', 24800]]);
  assert.equal(e.outcome!.reason, 'no_gap');
  assert.ok(!transitions(e).includes('GAP_GO_ARMED'));
  assert.ok(!transitions(e).includes('WILLIAMS_ARMED'));
  assert.equal(e.positionsToday, 0);
});

/* ---------------- data handling ---------------- */

test('a missing bar inside the Gap-and-Go window → DATA_ERROR (first breakout cannot be determined)', () => {
  const e = engine();
  const idx = steps(D, [...GAP_UP_OR, ['10:30', 25260]]);
  drive(e, { index: (t) => (hhmm(barLabelOf(D, t)) === '10:10' ? null : idx(t)) });
  assert.equal(e.state, 'DATA_ERROR');
  assert.equal(e.positionsToday, 0);
});

test('stale index ticks (> 5 s old on receipt) are rejected; late ticks never change a confirmed bar', () => {
  const e = engine();
  e.onIndexTick({ exchTs: at(D, '09:15:00'), recvTs: at(D, '09:15:07'), price: 25200 });
  assert.equal(e.reference, null);
  e.onIndexTick({ exchTs: at(D, '09:15:00'), recvTs: at(D, '09:15:00') + 100, price: 25200 });
  e.onClock(at(D, '09:16:02'));
  e.onIndexTick({ exchTs: at(D, '09:15:58'), recvTs: at(D, '09:16:02') + 500, price: 26000 });
  assert.equal(e.index.get(555)!.close, 25200);
  assert.ok(e.events.some((x) => x.trigger === 'late_tick'));
});
