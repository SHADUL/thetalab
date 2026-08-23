/* Black-Scholes, implied-vol solve and Greeks.
   Implied vol is solved from each observed premium, so every curve and Greek
   on screen is derived from real traded prices rather than an assumed vol. */

export const ncdf = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
export const npdf = (x) => 0.3989422804 * Math.exp(-x * x / 2);

export const bs = (S, K, T, v, isCall) => {
  if (T <= 1e-9 || v <= 1e-9) return Math.max(isCall ? S - K : K - S, 0);
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / sq;
  const d2 = d1 - sq;
  return isCall ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
};

export const impliedVol = (price, S, K, T, isCall) => {
  if (T <= 1e-9 || price == null) return null;
  const intrinsic = Math.max(isCall ? S - K : K - S, 0);
  if (price <= intrinsic + 0.01) return 0.01;
  let lo = 0.005, hi = 4;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bs(S, K, T, mid, isCall) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
};

export const greeks = (S, K, T, v, isCall) => {
  if (T <= 1e-9 || !v) {
    return { delta: isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0 };
  }
  const sq = v * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / sq;
  return {
    delta: isCall ? ncdf(d1) : ncdf(d1) - 1,
    gamma: npdf(d1) / (S * sq),
    theta: (-S * npdf(d1) * v / (2 * Math.sqrt(T))) / 365,
    vega: S * npdf(d1) * Math.sqrt(T) / 100,
  };
};

/* NIFTY lot size history — add a row when NSE revises it. */
export const LOTS = [
  { from: "1900-01-01", size: 75 },
  { from: "2026-01-01", size: 65 },
];
export const lotSize = (d) => [...LOTS].reverse().find((l) => d >= l.from)?.size ?? 75;
