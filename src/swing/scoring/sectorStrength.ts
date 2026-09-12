/**
 * Sector Strength (spec §15) — the one factor that can't be computed one
 * symbol at a time: "leading sector" is inherently relative to every other
 * sector on the same day, so this takes the whole universe's readings at
 * once and ranks sectors against each other, not against a fixed
 * threshold. Everything else in src/swing/scoring is per-symbol; this is
 * the exception, by necessity rather than inconsistency.
 *
 * No separate sector-index data source exists (or is needed): a sector's
 * return is the average of its own member stocks' returns on the same
 * metric already computed per stock (spec's own framing — "percentage of
 * stocks above 20 EMA" etc. — is a breadth statistic built the same way).
 */
export interface StockSectorInput {
  symbol: string;
  sector: string | null;
  return20d: number | null;
  return60d: number | null;
  aboveEma20: boolean | null;
  aboveEma50: boolean | null;
}

export interface SectorStrength {
  sector: string;
  avgReturn20d: number | null;
  avgReturn60d: number | null;
  pctAbove20ema: number | null;
  pctAbove50ema: number | null;
  memberCount: number;
  /** 0-100, ranked against every other sector present today — the highest-
   *  scoring sector on a given day is whichever is leading *that* day, not
   *  whichever clears some fixed bar. */
  score: number;
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((s, v) => s + v, 0) / present.length : null;
}
function pct(values: (boolean | null)[]): number | null {
  const present = values.filter((v): v is boolean => v != null);
  return present.length ? (present.filter(Boolean).length / present.length) * 100 : null;
}

/** Minimum members before a sector's reading is trusted enough to rank —
 *  a "sector" of one or two thinly-covered stocks isn't a breadth
 *  statistic, it's noise wearing a sector's name. Below this, the sector
 *  still gets a neutral score rather than being dropped, so its member
 *  stocks aren't left with no sector factor at all. */
const MIN_MEMBERS_TO_RANK = 3;
const NEUTRAL_SCORE = 50;

export function computeSectorStrength(stocks: StockSectorInput[]): Map<string, SectorStrength> {
  const bySector = new Map<string, StockSectorInput[]>();
  for (const s of stocks) {
    if (!s.sector) continue;
    const list = bySector.get(s.sector) ?? [];
    list.push(s);
    bySector.set(s.sector, list);
  }

  const raw = new Map<string, Omit<SectorStrength, 'score'> & { composite: number | null }>();
  for (const [sector, members] of bySector) {
    const avgReturn20d = average(members.map((m) => m.return20d));
    const avgReturn60d = average(members.map((m) => m.return60d));
    const pctAbove20ema = pct(members.map((m) => m.aboveEma20));
    const pctAbove50ema = pct(members.map((m) => m.aboveEma50));
    const composite = members.length < MIN_MEMBERS_TO_RANK ? null
      : composeSectorMetric(avgReturn20d, avgReturn60d, pctAbove20ema, pctAbove50ema);
    raw.set(sector, { sector, avgReturn20d, avgReturn60d, pctAbove20ema, pctAbove50ema, memberCount: members.length, composite });
  }

  const rankable = [...raw.values()].map((r) => r.composite).filter((c): c is number => c != null);
  const lo = rankable.length ? Math.min(...rankable) : null;
  const hi = rankable.length ? Math.max(...rankable) : null;

  const result = new Map<string, SectorStrength>();
  for (const [sector, r] of raw) {
    let score = NEUTRAL_SCORE;
    if (r.composite != null && lo != null && hi != null) {
      score = hi === lo ? NEUTRAL_SCORE : Math.round(((r.composite - lo) / (hi - lo)) * 100);
    }
    result.set(sector, { sector: r.sector, avgReturn20d: r.avgReturn20d, avgReturn60d: r.avgReturn60d,
      pctAbove20ema: r.pctAbove20ema, pctAbove50ema: r.pctAbove50ema, memberCount: r.memberCount, score });
  }
  return result;
}

function composeSectorMetric(
  avgReturn20d: number | null, avgReturn60d: number | null, pctAbove20ema: number | null, pctAbove50ema: number | null,
): number | null {
  const parts: [number | null, number][] = [[avgReturn20d, 0.35], [avgReturn60d, 0.25], [pctAbove20ema, 0.25], [pctAbove50ema, 0.15]];
  let sum = 0, weightUsed = 0;
  for (const [value, weight] of parts) {
    if (value == null) continue;
    sum += value * weight;
    weightUsed += weight;
  }
  return weightUsed === 0 ? null : sum / weightUsed;
}

/** What a stock's own factor score should be, given its sector's ranking —
 *  a neutral 50 for a stock with no sector on file (spec §55: reduce
 *  confidence rather than guess) or whose sector had too few members to
 *  rank meaningfully. */
export function sectorScoreFor(sector: string | null, strengths: Map<string, SectorStrength>): number {
  if (!sector) return NEUTRAL_SCORE;
  return strengths.get(sector)?.score ?? NEUTRAL_SCORE;
}
