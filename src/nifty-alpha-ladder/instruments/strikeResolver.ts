/**
 * Definition 3.2 (strike step) and Definition 3.3 (at-the-money strike).
 * Both derived from the actual listed strike ladder — never hard-coded.
 */

/** Δ(e) = min over positive gaps between consecutive distinct listed strikes. */
export function deriveStrikeStep(listedStrikes: number[]): number {
  const sorted = [...new Set(listedStrikes)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  if (!Number.isFinite(step)) throw new Error('deriveStrikeStep: fewer than two distinct listed strikes supplied.');
  return step;
}

/** K_ATM(S,e) = argmin|K−S|, ties resolved to the LOWER strike (scan-order tie-break, per Definition 3.3). */
export function selectATM(spot: number, listedStrikes: number[]): number {
  if (listedStrikes.length === 0) throw new Error('selectATM: no listed strikes supplied.');
  const sorted = [...listedStrikes].sort((a, b) => a - b);
  let best = sorted[0];
  let bestDist = Math.abs(sorted[0] - spot);
  for (let i = 1; i < sorted.length; i++) {
    const dist = Math.abs(sorted[i] - spot);
    if (dist < bestDist) {
      best = sorted[i];
      bestDist = dist;
    }
    // dist === bestDist: keep the existing (lower, since sorted ascending
    // and we only overwrite on strictly-smaller distance) — the tie goes
    // to the lower strike by construction of this scan order.
  }
  return best;
}
