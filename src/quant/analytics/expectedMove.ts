/**
 * Expected Move ≈ Underlying × IV × sqrt(T). The textbook lognormal 1σ
 * range. Same limitation as everywhere else this engine uses a lognormal
 * assumption: index returns gap and are fat-tailed, so this UNDERSTATES how
 * far price can actually travel, especially near expiry or around events.
 */
export interface ExpectedMove {
  /** 1-sigma move in underlying points. */
  points: number;
  /** 1-sigma move as a fraction of the underlying, e.g. 0.014 = 1.4%. */
  pct: number;
  oneSigma: { lower: number; upper: number };
  twoSigma: { lower: number; upper: number };
}

export function expectedMove(
  underlying: number,
  iv: number,
  timeToExpiryYears: number,
): ExpectedMove | null {
  if (!(underlying > 0) || !(iv > 0) || !(timeToExpiryYears >= 0)) return null;
  const points = underlying * iv * Math.sqrt(timeToExpiryYears);
  return {
    points,
    pct: points / underlying,
    oneSigma: { lower: underlying - points, upper: underlying + points },
    twoSigma: { lower: underlying - 2 * points, upper: underlying + 2 * points },
  };
}
