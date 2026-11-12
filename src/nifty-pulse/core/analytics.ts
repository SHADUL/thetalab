/**
 * Performance analytics from RECORDED paper trades only. Nothing here
 * estimates or extrapolates; with a small sample the result says so.
 */
import type { PaperPosition } from './paperBroker.ts';
import type { EngineStats } from './engine.ts';
import { istMinute } from './engine.ts';

export const MIN_SAMPLE_FOR_STATS = 30;

export interface Bucket { key: string; trades: number; wins: number; net: number; avg: number; winRate: number | null }

export interface Analytics {
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  grossPnl: number;
  netPnl: number;
  estCosts: number;
  detailedCosts: number;
  maxDrawdown: number;
  avgHoldSec: number | null;
  avgCreditCapturedPct: number | null;
  rejectionRate: number | null;
  conversion: number | null;
  daily: Array<{ date: string; net: number; trades: number }>;
  equity: Array<{ t: number; equity: number; tradeId: string }>;
  byHour: Bucket[];
  byDirection: Bucket[];
  byExpiry: Bucket[];
  byWidth: Bucket[];
  byHold: Bucket[];
  byExit: Bucket[];
  sampleWarning: string | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function bucketize(trades: PaperPosition[], keyOf: (t: PaperPosition) => string, order?: string[]): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const t of trades) {
    const k = keyOf(t);
    const b = m.get(k) ?? { key: k, trades: 0, wins: 0, net: 0, avg: 0, winRate: null };
    b.trades++;
    if ((t.realizedNet ?? 0) > 0) b.wins++;
    b.net = r2(b.net + (t.realizedNet ?? 0));
    m.set(k, b);
  }
  const out = [...m.values()].map((b) => ({ ...b, avg: r2(b.net / b.trades), winRate: b.trades ? b.wins / b.trades : null }));
  return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => a.key.localeCompare(b.key));
}

const istDate = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

export function computeAnalytics(closed: PaperPosition[], stats: Pick<EngineStats, 'episodes' | 'attempts' | 'entries' | 'rejections'> | null): Analytics {
  const trades = closed.filter((t) => t.status === 'CLOSED' && t.realizedNet != null).sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  const nets = trades.map((t) => t.realizedNet!);
  const winsArr = nets.filter((x) => x > 0);
  const lossArr = nets.filter((x) => x < 0);
  const grossWin = winsArr.reduce((a, b) => a + b, 0);
  const grossLoss = -lossArr.reduce((a, b) => a + b, 0);

  let eq = 0, peak = 0, mdd = 0;
  const equity = trades.map((t) => {
    eq = r2(eq + t.realizedNet!);
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, peak - eq);
    return { t: t.exitAt!, equity: eq, tradeId: t.id };
  });

  const dailyMap = new Map<string, { date: string; net: number; trades: number }>();
  for (const t of trades) {
    const d = istDate(t.exitAt!);
    const e = dailyMap.get(d) ?? { date: d, net: 0, trades: 0 };
    e.net = r2(e.net + t.realizedNet!);
    e.trades++;
    dailyMap.set(d, e);
  }

  const holdKey = (s: number | null) => (s == null ? '—' : s < 30 ? '<30s' : s < 60 ? '30–60s' : s < 90 ? '60–90s' : s < 120 ? '90–120s' : '120s+');
  const hourKey = (ms: number) => { const m = istMinute(ms); const h = Math.floor(m / 60); return `${String(h).padStart(2, '0')}:00`; };

  const n = trades.length;
  const sampleWarning = n === 0
    ? 'No completed paper trades yet — nothing to analyse.'
    : n < MIN_SAMPLE_FOR_STATS
      ? `Only ${n} completed trade${n === 1 ? '' : 's'}. At least ${MIN_SAMPLE_FOR_STATS} are needed before these figures mean anything, and even then they are not evidence of profitability without out-of-sample live paper results.`
      : null;

  return {
    trades: n,
    wins: winsArr.length,
    losses: lossArr.length,
    flats: n - winsArr.length - lossArr.length,
    winRate: n ? winsArr.length / n : null,
    avgWin: winsArr.length ? r2(grossWin / winsArr.length) : null,
    avgLoss: lossArr.length ? r2(-grossLoss / lossArr.length) : null,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    grossPnl: r2(trades.reduce((a, t) => a + (t.realizedGross ?? 0), 0)),
    netPnl: r2(nets.reduce((a, b) => a + b, 0)),
    estCosts: r2(trades.reduce((a, t) => a + t.roundTripCost, 0)),
    detailedCosts: r2(trades.reduce((a, t) => a + t.entryFeesDetailed.total + (t.exitFeesDetailed?.total ?? 0), 0)),
    maxDrawdown: r2(mdd),
    avgHoldSec: n ? Math.round(trades.reduce((a, t) => a + (t.holdSec ?? 0), 0) / n) : null,
    avgCreditCapturedPct: n ? r2((trades.reduce((a, t) => a + (t.realizedGross ?? 0) / t.grossCredit, 0) / n) * 100) : null,
    rejectionRate: stats && stats.attempts ? stats.rejections / stats.attempts : null,
    conversion: stats && stats.episodes ? stats.entries / stats.episodes : null,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    equity,
    byHour: bucketize(trades, (t) => hourKey(t.entryAt)),
    byDirection: bucketize(trades, (t) => (t.direction === 'BULLISH' ? 'Bullish · bull put' : 'Bearish · bear call')),
    byExpiry: bucketize(trades, (t) => t.expiry),
    byWidth: bucketize(trades, (t) => `${t.widthPts} pts`),
    byHold: bucketize(trades, (t) => holdKey(t.holdSec), ['<30s', '30–60s', '60–90s', '90–120s', '120s+']),
    byExit: bucketize(trades, (t) => t.exitReason ?? '—'),
    sampleWarning,
  };
}
