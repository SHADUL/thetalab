export interface IntradaySectorInput {
  symbol: string;
  sector: string | null;
  intradayReturnPct: number;
  aboveVwap: boolean;
}

export interface IntradaySectorStrength {
  sector: string;
  avgReturnPct: number;
  pctAboveVwap: number;
  memberCount: number;
  /** 0-100, ranked against every other sector present right now — the
   *  leading sector today, not one clearing some fixed bar. Same
   *  cross-sectional ranking approach as the Swing Scanner's sector
   *  strength, re-derived here (not imported) to keep this module
   *  independent, per spec §2. */
  score: number;
}

const MIN_MEMBERS_TO_RANK = 3;
const NEUTRAL_SCORE = 50;

export function computeIntradaySectorStrength(stocks: IntradaySectorInput[]): Map<string, IntradaySectorStrength> {
  const bySector = new Map<string, IntradaySectorInput[]>();
  for (const s of stocks) {
    if (!s.sector) continue;
    const list = bySector.get(s.sector) ?? [];
    list.push(s);
    bySector.set(s.sector, list);
  }

  const raw = new Map<string, { avgReturnPct: number; pctAboveVwap: number; memberCount: number; composite: number | null }>();
  for (const [sector, members] of bySector) {
    const avgReturnPct = members.reduce((s, m) => s + m.intradayReturnPct, 0) / members.length;
    const pctAboveVwap = (members.filter((m) => m.aboveVwap).length / members.length) * 100;
    const composite = members.length < MIN_MEMBERS_TO_RANK ? null : avgReturnPct * 0.7 + (pctAboveVwap - 50) * 0.3;
    raw.set(sector, { avgReturnPct, pctAboveVwap, memberCount: members.length, composite });
  }

  const rankable = [...raw.values()].map((r) => r.composite).filter((c): c is number => c != null);
  const lo = rankable.length ? Math.min(...rankable) : null;
  const hi = rankable.length ? Math.max(...rankable) : null;

  const result = new Map<string, IntradaySectorStrength>();
  for (const [sector, r] of raw) {
    let score = NEUTRAL_SCORE;
    if (r.composite != null && lo != null && hi != null) {
      score = hi === lo ? NEUTRAL_SCORE : Math.round(((r.composite - lo) / (hi - lo)) * 100);
    }
    result.set(sector, { sector, avgReturnPct: r.avgReturnPct, pctAboveVwap: r.pctAboveVwap, memberCount: r.memberCount, score });
  }
  return result;
}

export function sectorScoreFor(sector: string | null, strengths: Map<string, IntradaySectorStrength>): number {
  if (!sector) return NEUTRAL_SCORE;
  return strengths.get(sector)?.score ?? NEUTRAL_SCORE;
}
