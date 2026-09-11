/**
 * Volume ratio and its qualitative bands (spec §12) — deliberately just a
 * ratio, not a score by itself. Panic-selling volume and breakout volume
 * look identical here; telling them apart needs price action alongside it,
 * which is the ranking engine's job, not this module's.
 */
import { sma } from './movingAverages.ts';

export function volumeRatio(volumes: number[], period = 20): (number | null)[] {
  const avg = sma(volumes, period);
  return volumes.map((v, i) => (avg[i] == null || avg[i] === 0 ? null : v / avg[i]!));
}

export type VolumeBand = 'weak' | 'normal' | 'positive' | 'strong' | 'exceptional';

/** Spec §12's bands, verbatim. */
export function classifyVolumeRatio(ratio: number | null): VolumeBand | null {
  if (ratio == null) return null;
  if (ratio < 0.7) return 'weak';
  if (ratio < 1.0) return 'normal';
  if (ratio < 1.5) return 'positive';
  if (ratio < 2.0) return 'strong';
  return 'exceptional';
}
