import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetById, deriveVersion, type PulseConfig } from '../core/config.ts';
import { priceSpread, buildCandidates, expiryPayoff } from '../core/spreads.ts';
import { orderCharges, spreadRoundTripDetailed } from '../core/costs.ts';
import { approveCandidate, preTradeChecks, selectApproved, type RiskState } from '../core/risk.ts';
import { openPaperPosition, stepPosition, markPosition } from '../core/paperBroker.ts';
import { fakeChain, T0 } from './helpers.ts';

const A = presetById('strategy-a-baseline')!;
const X = presetById('strategy-a-extended-risk')!;

const putChain = (over: Record<string, any> = {}, at = T0) => fakeChain({
  spot: 25_010, at,
  quotes: { '25000PE': [100, 100.5], '24950PE': [80, 80.5], '24900PE': [63, 63.5], '24850PE': [49, 49.5], '24800PE': [37, 37.5], ...over },
});

// ── Spread construction & pricing ────────────────────────────────────
test('bull put: sell the short at bid, buy the long at ask, slippage against us; max loss = (width − credit) × qty + costs', () => {
  const c = priceSpread(putChain(), 'BULL_PUT', 25_000, 1, A);
  assert.equal(c.long.strike, 24_950);
  assert.equal(c.short.right, 'PE');
  assert.equal(c.shortEntry, 99.95);
  assert.equal(c.longEntry, 80.55);
  assert.equal(c.creditPts, 19.4);
  assert.equal(c.qty, 65);
  assert.equal(c.grossCredit, 1261);
  assert.equal(c.grossMaxLoss, Math.round((50 - 19.4) * 65 * 100) / 100);
  assert.equal(c.roundTripCost, 150);
  assert.equal(c.maxLoss, c.grossMaxLoss! + 150);
  assert.equal(c.breakeven, 24_980.6);
  assert.equal(c.eligible, true);
});

test('bear call: long strike is ABOVE the short (correct hedge direction)', () => {
  const ch = fakeChain({ spot: 25_000, quotes: { '25000CE': [110, 110.5], '25050CE': [88, 88.5] } });
  const c = priceSpread(ch, 'BEAR_CALL', 25_000, 1, A);
  assert.equal(c.long.strike, 25_050);
  assert.equal(c.long.right, 'CE');
  assert.ok(c.creditPts! > 0);
});

test('spread rejects: missing protective long, zero/negative credit, stale quote, wide market, thin depth, mixed expiry', () => {
  assert.equal(priceSpread(putChain({ '24950PE': undefined }), 'BULL_PUT', 25_000, 1, A).eligible, false);
  const neg = priceSpread(putChain({ '25000PE': [80, 80.5], '24950PE': [80, 80.5] }), 'BULL_PUT', 25_000, 1, A);
  assert.equal(neg.eligible, false);
  assert.match(neg.rejectReason!, /Net credit positive/);
  const stale = priceSpread(putChain({ '24950PE': { bid: 80, ask: 80.5, ts: T0 - 10_000 } }), 'BULL_PUT', 25_000, 1, A);
  assert.match(stale.rejectReason!, /Long quote fresh/);
  const wide = priceSpread(putChain({ '25000PE': [98, 102] }), 'BULL_PUT', 25_000, 1, A);
  assert.match(wide.rejectReason!, /bid\/ask spread/);
  const thin = priceSpread(putChain({ '25000PE': { bid: 100, ask: 100.5, bidQty: 20 } }), 'BULL_PUT', 25_000, 1, A);
  assert.match(thin.rejectReason!, /depth/);
  const oneSided = priceSpread(putChain({ '25000PE': [null, 100.5] }), 'BULL_PUT', 25_000, 1, A);
  assert.equal(oneSided.eligible, false);
  const mixed = priceSpread(putChain({ '24950PE': { bid: 80, ask: 80.5, expiry: '2026-11-24' } }), 'BULL_PUT', 25_000, 1, A);
  assert.match(mixed.rejectReason!, /Same expiry/);
});

test('buildCandidates searches ATM..ATM−3 shorts × 1..4 widths, eligible first', () => {
  const cands = buildCandidates(putChain(), 'BULLISH', A);
  assert.equal(cands.length, 16);
  assert.ok(cands.every((c) => c.kind === 'BULL_PUT' && c.long.strike < c.short.strike));
  const firstIneligible = cands.findIndex((c) => !c.eligible);
  assert.ok(firstIneligible === -1 || cands.slice(firstIneligible).every((c) => !c.eligible));
});

test('expiry payoff: max gain above the short, max loss below the long (bull put)', () => {
  const c = priceSpread(putChain(), 'BULL_PUT', 25_000, 1, A);
  assert.equal(expiryPayoff(c, 26_000), c.netCredit);
  assert.equal(expiryPayoff(c, 24_000), -c.maxLoss!);
  assert.ok(Math.abs(expiryPayoff(c, c.breakeven!) + c.roundTripCost!) < 0.01);
});

// ── Costs ─────────────────────────────────────────────────────────────
test('costs: STT only on the sell side, stamp only on the buy side, 4 orders of brokerage per round trip', () => {
  const s = orderCharges('SELL', 100, 65), b = orderCharges('BUY', 100, 65);
  assert.ok(s.stt > 0 && s.stamp === 0);
  assert.ok(b.stt === 0 && b.stamp > 0);
  const rt = spreadRoundTripDetailed({ shortEntry: 100, longEntry: 80, shortExit: 99, longExit: 79, qty: 65 });
  assert.equal(rt.brokerage, 80);
  assert.ok(rt.total > 80);
});

// ── Risk engine ──────────────────────────────────────────────────────
const okState = (o: Partial<RiskState> = {}): RiskState => ({
  nowMs: T0, engineRunning: true, killSwitch: false, openPositions: 0, tradesToday: 0, realizedToday: 0,
  lastExitAt: null, marketOpen: true, feedHealthy: true, ...o,
});

test('risk: baseline ₹1,000 rejects every liquid near-ATM spread with the exact message; Extended Risk approves', () => {
  const cands = buildCandidates(putChain(), 'BULLISH', A);
  const a = selectApproved(cands, okState(), A);
  assert.equal(a.chosen, null);
  assert.equal(a.reason, 'NO ELIGIBLE SPREAD WITHIN RISK LIMIT');
  const x = selectApproved(buildCandidates(putChain(), 'BULLISH', X), okState(), X);
  assert.ok(x.chosen);
  assert.ok(x.chosen!.maxLoss! <= 2_500);
  assert.equal(x.decision!.approved, true);
});

test('risk: daily loss cutoff, worst case must fit the remaining budget, trade count, cooldown, position limit, engine stop, kill switch', () => {
  const cand = priceSpread(putChain(), 'BULL_PUT', 25_000, 1, X);
  const fail = (s: Partial<RiskState>) => approveCandidate(cand, okState(s), X);
  assert.match(fail({ realizedToday: -3_000 }).reason!, /Daily loss limit reached/);
  assert.match(fail({ realizedToday: -1_000 }).reason!, /remaining daily loss budget/);
  assert.match(fail({ tradesToday: 5 }).reason!, /Daily trade limit reached/);
  assert.match(fail({ lastExitAt: T0 - 30_000 }).reason!, /Cooldown active — 30s left/);
  assert.equal(fail({ lastExitAt: T0 - 60_000 }).approved, true);
  assert.match(fail({ openPositions: 1 }).reason!, /Position already open/);
  assert.match(fail({ engineRunning: false }).reason!, /Engine stopped/);
  assert.match(fail({ killSwitch: true }).reason!, /Kill switch/);
  assert.match(fail({ feedHealthy: false }).reason!, /stale or disconnected/);
  const tight = deriveVersion(X, { maxMarginAllocation: 1_000 }, 2);
  assert.match(approveCandidate(cand, okState(), tight).reason!, /Margin allocation \(estimate\)/);
});

test('risk: paper-only is checked server-side on every decision', () => {
  const rogue = { ...X, paperOnly: false } as unknown as PulseConfig;
  assert.equal(preTradeChecks(okState(), rogue).find((k) => k.key === 'PAPER_ONLY')!.pass, false);
});

// ── Paper broker & exits ─────────────────────────────────────────────
function opened(at = T0) {
  const cand = priceSpread(putChain({}, at), 'BULL_PUT', 25_000, 1, X);
  return openPaperPosition({ cand, direction: 'BULLISH', config: X, at, tradeNo: 1, dataMode: 'SIMULATION', entryReason: 'test', signal: { price: 25_010, r5: 0.02, r15: 0.04, ma60: 25_000, ups: 5, downs: 0 } });
}

test('paper broker: two PAPER_FILL legs, credit at bid/ask, target 20% / stop 30% of gross credit', () => {
  const p = opened();
  assert.equal(p.fills.length, 2);
  assert.ok(p.fills.every((f) => f.kind === 'PAPER_FILL'));
  assert.deepEqual(p.fills.map((f) => [f.leg, f.side, f.basis]), [['SHORT', 'SELL', 'BID'], ['LONG', 'BUY', 'ASK']]);
  assert.equal(p.targetPnl, Math.round(p.grossCredit * 0.2 * 100) / 100);
  assert.equal(p.stopPnl, -Math.round(p.grossCredit * 0.3 * 100) / 100);
  assert.throws(() => openPaperPosition({ cand: priceSpread(putChain({ '24950PE': undefined }), 'BULL_PUT', 25_000, 1, X), direction: 'BULLISH', config: X, at: T0, tradeNo: 2, dataMode: 'SIMULATION', entryReason: '', signal: p.signal }));
});

test('exit: close at short ask / long bid; marked net = gross − round-trip cost', () => {
  const p = opened();
  const m = markPosition(p, putChain({}, T0 + 5_000), X);
  assert.equal(m.priced, true);
  assert.equal(m.closingDebitPts, Math.round((100.5 + 0.05 - (80 - 0.05)) * 100) / 100);
  assert.equal(m.markedNet, Math.round(((p.creditPts - m.closingDebitPts!) * p.qty - 150) * 100) / 100);
});

test('exit: profit target, stop loss and 120 s time exit', () => {
  const p = opened();
  // Spread collapses (short cheap, long cheap): profit.
  const tp = stepPosition(p, putChain({ '25000PE': [60, 60.2], '24950PE': [52, 52.2] }, T0 + 10_000), X);
  assert.equal(tp.status, 'CLOSED'); assert.equal(tp.exitReason, 'PROFIT_TARGET'); assert.ok(tp.realizedNet! >= p.targetPnl);
  // Spread widens: loss.
  const sl = stepPosition(p, putChain({ '25000PE': [130, 130.5], '24950PE': [100, 100.5] }, T0 + 10_000), X);
  assert.equal(sl.exitReason, 'STOP_LOSS'); assert.ok(sl.realizedNet! <= p.stopPnl);
  // Unchanged market, held 120 s.
  const hold = stepPosition(p, putChain({}, T0 + 60_000), X);
  assert.equal(hold.status, 'OPEN');
  const te = stepPosition(hold, putChain({}, T0 + 120_000), X);
  assert.equal(te.exitReason, 'TIME_EXIT'); assert.equal(te.holdSec, 120);
  assert.equal(te.fills.length, 4);
});

test('exit: stale prices never produce a fill — PENDING_EXIT, then filled once quotes are valid', () => {
  const p = opened();
  const staleChain = putChain({ '25000PE': { bid: 100, ask: 100.5, ts: T0 }, '24950PE': { bid: 80, ask: 80.5, ts: T0 } }, T0 + 125_000);
  const pend = stepPosition(p, staleChain, X);
  assert.equal(pend.status, 'PENDING_EXIT');
  assert.equal(pend.pendingExit!.reason, 'TIME_EXIT');
  assert.equal(pend.fills.length, 2);
  const still = stepPosition(pend, putChain({ '24950PE': undefined }, T0 + 126_000), X);
  assert.equal(still.status, 'PENDING_EXIT');
  const done = stepPosition(still, putChain({}, T0 + 130_000), X);
  assert.equal(done.status, 'CLOSED'); assert.equal(done.exitReason, 'TIME_EXIT');
});

// ── Paper-only enforcement (static) ──────────────────────────────────
test('paper-only: strategy core has no network access; no NIFTY PULSE file can reach Kite or an order endpoint', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const walk = (d: string, out: string[] = []) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) { if (f !== '__tests__') walk(p, out); } else if (/\.(ts|js|jsx)$/.test(f)) out.push(p);
    }
    return out;
  };
  const core = walk(root);
  let ui: string[] = [];
  try { ui = walk(path.resolve(root, '../components/nifty-pulse')); } catch { /* UI not present */ }
  assert.ok(core.length >= 10);
  const broker = [/api\.kite\.trade/, /kite\.zerodha/, /\/orders\b/, /place_?order/i, /kiteconnect/i, /\bWebSocket\b/, /access_token/];
  const network = [/\bfetch\s*\(/, /XMLHttpRequest/, /from ['"](node:)?(http|https|net|tls)['"]/, /EventSource/];
  for (const f of core) {
    const src = readFileSync(f, 'utf8');
    for (const re of [...broker, ...network]) assert.ok(!re.test(src), `${path.relative(root, f)} matches ${re}`);
  }
  for (const f of ui) {
    const src = readFileSync(f, 'utf8');
    for (const re of broker) assert.ok(!re.test(src), `${path.relative(root, f)} matches ${re}`);
  }
});
