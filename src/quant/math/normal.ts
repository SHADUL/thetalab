/**
 * Standard normal distribution helpers.
 *
 * The CDF uses Hart's double-precision rational approximation (accurate to
 * roughly 1e-15 across the whole real line). The cheap Abramowitz-Stegun
 * 7.1.26 form is only good to ~7.5e-8, which is not enough: it introduces
 * visible error in deep-OTM probabilities, which is exactly where tail-risk
 * numbers live.
 */

const INV_SQRT_2PI = 0.3989422804014327;

/** Standard normal probability density function. */
export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/** Standard normal cumulative distribution function (Hart 1968). */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;

  const y = Math.abs(x);
  if (y > 37) return x > 0 ? 1 : 0;

  const e = Math.exp(-0.5 * y * y);
  let c: number;

  if (y < 7.07106781186547) {
    let num = 3.52624965998911e-2 * y + 0.700383064443688;
    num = num * y + 6.37396220353165;
    num = num * y + 33.912866078383;
    num = num * y + 112.079291497871;
    num = num * y + 221.213596169931;
    num = num * y + 220.206867912376;

    let den = 8.83883476483184e-2 * y + 1.75566716318264;
    den = den * y + 16.064177579207;
    den = den * y + 86.7807322029461;
    den = den * y + 296.564248779674;
    den = den * y + 637.333633378831;
    den = den * y + 793.826512519948;
    den = den * y + 440.413735824752;

    c = (e * num) / den;
  } else {
    let b = y + 0.65;
    b = y + 4 / b;
    b = y + 3 / b;
    b = y + 2 / b;
    b = y + 1 / b;
    c = e / (b * 2.506628274631);
  }

  return x > 0 ? 1 - c : c;
}

/**
 * Inverse standard normal CDF (Acklam's algorithm, refined with one
 * Halley step). Needed for Monte Carlo and for probability-of-touch work
 * in later phases.
 */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  // One Halley refinement step to reach full double precision.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(0.5 * x * x);
  x = x - u / (1 + 0.5 * x * u);

  return x;
}
