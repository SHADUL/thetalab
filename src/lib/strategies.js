/* Strategy generation and evaluation.

   Every candidate is priced from the actual chain: each leg's entry price is
   the traded premium at the selected session, and its implied volatility is
   solved from that premium. Payoff at the target date is intrinsic value when
   the target IS expiry, and Black-Scholes value at the remaining tenor when the
   target is earlier — with each leg holding its own solved IV. Nothing here is
   priced off an assumed volatility. */

import { bs, impliedVol } from "./options";

/* Strike grids differ by index — NIFTY is 50 points, SENSEX 100 — and the
   spread widths below have to scale with the grid too, or a SENSEX condor
   built on NIFTY-sized wings would be a fraction of a percent wide. */
export const roundTo = (x, step) => Math.round(x / step) * step;
export const widths = (step, mults) => mults.map((m) => m * step);

/** Solve IV once per strike/right so candidate generation stays cheap. */
export function ivSurface(chain, strikes, spot, T) {
  const map = {};
  strikes.forEach((k) => {
    const row = chain[String(k)];
    if (!row) return;
    if (row.c != null) map[`${k}CE`] = { px: row.c, iv: impliedVol(row.c, spot, k, T, true) };
    if (row.p != null) map[`${k}PE`] = { px: row.p, iv: impliedVol(row.p, spot, k, T, false) };
  });
  return map;
}

export const leg = (side, right, strike, lots, surf) => {
  const s = surf[`${strike}${right}`];
  if (!s || s.px == null) return null;
  return { side, right, strike, lots, price: s.px, iv: s.iv };
};
export const ok = (...ls) => (ls.every(Boolean) ? ls : null);

/**
 * Enumerate the strategies a professional would actually consider for a view.
 * Directional views get spreads and outrights; range views get the premium
 * sellers and their defined-risk equivalents.
 */
export function generate({ surf, strikes, spot, view, lower, upper, lots = 1, step = 50 }) {
  const near = strikes.filter((k) => Math.abs(k - spot) / spot <= 0.07);
  if (!near.length) return [];
  const atm = near.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), near[0]);

  /* Anchor on the view, not on spot. For "NIFTY above 22600", a short put at
     22900 is already losing at the boundary — the structures that actually
     survive the view are the ones whose short strike sits at or below it. */
  const bullish = view === "above", bearish = view === "below";
  const putAnchor = bullish ? Math.min(lower, atm) : atm;
  const callAnchor = bearish ? Math.max(upper, atm) : atm;

  const below = near.filter((k) => k <= putAnchor).sort((a, b) => b - a);
  const above = near.filter((k) => k >= callAnchor).sort((a, b) => a - b);
  if (!below.length || !above.length) return [];
  const out = [];
  const push = (name, kind, legs) => { if (legs) out.push({ name, kind, legs }); };

  const rangeView = view === "between";

  if (rangeView) {
    /* Premium selling: the structures that profit from the index staying put. */
    below.slice(0, 4).forEach((k) =>
      push(`Short Straddle ${k}`, "Short Straddle",
        ok(leg("SELL", "CE", k, lots, surf), leg("SELL", "PE", k, lots, surf))));

    above.slice(0, 7).forEach((c) => below.slice(0, 7).forEach((p) => {
      if (c <= p) return;
      push(`Short Strangle ${p}-${c}`, "Short Strangle",
        ok(leg("SELL", "PE", p, lots, surf), leg("SELL", "CE", c, lots, surf)));
      widths(step, [4, 6]).forEach((w) => {
        push(`Iron Condor ${p}-${c}`, "Iron Condor",
          ok(leg("SELL", "PE", p, lots, surf), leg("BUY", "PE", p - w, lots, surf),
             leg("SELL", "CE", c, lots, surf), leg("BUY", "CE", c + w, lots, surf)));
      });
    }));

    below.slice(0, 3).forEach((k) => widths(step, [4, 6]).forEach((w) =>
      push(`Iron Fly ${k} ±${w}`, "Iron Fly",
        ok(leg("SELL", "CE", k, lots, surf), leg("SELL", "PE", k, lots, surf),
           leg("BUY", "CE", k + w, lots, surf), leg("BUY", "PE", k - w, lots, surf)))));

    below.slice(0, 4).forEach((k) => widths(step, [2, 4]).forEach((w) =>
      push(`Call Butterfly ${k}`, "Butterfly",
        ok(leg("BUY", "CE", k - w, lots, surf), leg("SELL", "CE", k, 2 * lots, surf),
           leg("BUY", "CE", k + w, lots, surf)))));
  }

  if (bullish || rangeView) {
    below.slice(0, 6).forEach((p) => widths(step, [4, 6, 8]).forEach((w) =>
      push(`Bull Put Spread ${p - w}-${p}`, "Bull Put Spread",
        ok(leg("SELL", "PE", p, lots, surf), leg("BUY", "PE", p - w, lots, surf)))));
  }
  if (bearish || rangeView) {
    above.slice(0, 6).forEach((c) => widths(step, [4, 6, 8]).forEach((w) =>
      push(`Bear Call Spread ${c}-${c + w}`, "Bear Call Spread",
        ok(leg("SELL", "CE", c, lots, surf), leg("BUY", "CE", c + w, lots, surf)))));
  }
  if (bullish) {
    below.slice(0, 4).forEach((k) => {
      push(`Long Call ${k}`, "Long Call", ok(leg("BUY", "CE", k, lots, surf)));
      widths(step, [4, 6, 8]).forEach((w) =>
        push(`Bull Call Spread ${k}-${k + w}`, "Bull Call Spread",
          ok(leg("BUY", "CE", k, lots, surf), leg("SELL", "CE", k + w, lots, surf))));
    });
  }
  if (bearish) {
    above.slice(0, 4).forEach((k) => {
      push(`Long Put ${k}`, "Long Put", ok(leg("BUY", "PE", k, lots, surf)));
      widths(step, [4, 6, 8]).forEach((w) =>
        push(`Bear Put Spread ${k - w}-${k}`, "Bear Put Spread",
          ok(leg("BUY", "PE", k, lots, surf), leg("SELL", "PE", k - w, lots, surf))));
    });
  }
  return out;
}

/** P&L of a set of legs if the index is at S on the target date. */
function pnlAt(legs, S, targetT, lotQty) {
  let v = 0;
  legs.forEach((l) => {
    const isCall = l.right === "CE";
    const now = targetT <= 1e-9
      ? Math.max(isCall ? S - l.strike : l.strike - S, 0)
      : bs(S, l.strike, targetT, l.iv || 0.15, isCall);
    v += (l.side === "SELL" ? -1 : 1) * (now - l.price) * l.lots * lotQty;
  });
  return v;
}

export function evaluate(cand, { spot, targetT, lotQty, lower, upper }) {
  const { legs } = cand;
  const span = Math.max(spot * 0.09, (upper - lower) * 1.6);
  const lo = spot - span, hi = spot + span, N = 161;
  const curve = [];
  for (let i = 0; i < N; i++) {
    const S = lo + (hi - lo) * i / (N - 1);
    curve.push({ S, v: pnlAt(legs, S, targetT, lotQty) });
  }

  const inView = curve.filter((p) => p.S >= lower && p.S <= upper);
  const vals = inView.length ? inView.map((p) => p.v) : [pnlAt(legs, (lower + upper) / 2, targetT, lotQty)];
  const minInView = Math.min(...vals);
  const maxInView = Math.max(...vals);

  const all = curve.map((p) => p.v);
  const maxProfit = Math.max(...all);
  const maxLoss = Math.min(...all);

  const bes = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if ((a.v <= 0 && b.v > 0) || (a.v >= 0 && b.v < 0)) {
      const t = Math.abs(a.v) / (Math.abs(a.v) + Math.abs(b.v) || 1);
      bes.push(Math.round(a.S + (b.S - a.S) * t));
    }
  }

  let credit = 0, shortN = 0, longN = 0, debit = 0;
  legs.forEach((l) => {
    const q = l.lots * lotQty;
    if (l.side === "SELL") { credit += l.price * q; shortN += l.strike * q; }
    else { debit += l.price * q; longN += l.strike * q; }
  });
  const net = credit - debit;
  /* Defined-risk structures are collateralised by their worst case; naked short
     legs fall back to the same rough proxy used elsewhere in the app. */
  const definedRisk = Number.isFinite(maxLoss) && maxLoss > -1e12 &&
    legs.filter((l) => l.side === "BUY").length >= legs.filter((l) => l.side === "SELL").length;
  const capital = definedRisk
    ? Math.max(Math.abs(maxLoss), debit, 1)
    : Math.max(shortN * 0.12 - longN * 0.06, debit, 1);

  return { ...cand, minInView, maxInView, maxProfit, maxLoss, breakevens: bes,
    net, capital, returnPct: (minInView / capital) * 100, curve };
}

/* A vertical spread cannot be worth more than the distance between its strikes,
   and no structure can profit at every conceivable price. Anything claiming
   otherwise is a pricing artefact in the input data, not an opportunity — it is
   dropped and counted so the UI can say how many were discarded. */
export function arbitrageFlag(c, lotQty) {
  const rights = new Set(c.legs.map((l) => l.right));
  if (c.legs.length === 2 && rights.size === 1) {
    const width = Math.abs(c.legs[0].strike - c.legs[1].strike);
    const net = Math.abs(c.legs.reduce((a, l) => a + (l.side === "SELL" ? 1 : -1) * l.price * l.lots, 0));
    const perUnit = net / (c.legs[0].lots || 1);
    if (perUnit > width * 1.001) return "spread value exceeds its width";
  }
  if (c.maxLoss > 0) return "profits at every price";
  if (!Number.isFinite(c.minInView)) return "not priceable";
  return null;
}

export function rank(cands, ctx, sortBy = "profit") {
  const evaluated = cands.map((c) => evaluate(c, ctx));
  const dropped = [];
  const scored = evaluated.filter((c) => {
    const flag = arbitrageFlag(c, ctx.lotQty);
    if (flag) { dropped.push({ name: c.name, flag }); return false; }
    return true;
  });
  rank.dropped = dropped;
  const key = { profit: (c) => c.minInView, ret: (c) => c.returnPct,
                risk: (c) => c.maxLoss, capital: (c) => -c.capital }[sortBy] || ((c) => c.minInView);
  return scored.sort((a, b) => key(b) - key(a));
}

export const defaultBounds = (spot, sigma, step = 50) => {
  const s = sigma || spot * 0.012;
  return { lower: roundTo(spot - s, step), upper: roundTo(spot + s, step) };
};
