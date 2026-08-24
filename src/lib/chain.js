/* Chain-level analytics: the numbers a desk reads off the top of an option
   chain before it looks at any single strike.

   Everything here is derived from the bundle's own observed premiums and open
   interest. Nothing is assumed, and nothing is fetched — if a figure cannot be
   computed from the session in view it comes back null so the UI can say so
   rather than print a confident wrong number. */

import { bs, impliedVol, greeks as bsGreeks } from "./options";

/* One strike's price on whichever basis the desk is reading.
   "open" is the session's first trade, "settle" the exchange's settlement.
   Everything that quotes a premium goes through here, so the whole panel
   describes a single moment rather than mixing the morning with the close. */
const px = (row, side, basis) => {
  if (!row) return null;
  const k = basis === "open" ? (side === "c" ? "c0" : "p0") : side;
  return row[k] ?? null;
};

/* ── strikes ─────────────────────────────────────────────────────────── */

export const atmStrike = (strikes, ref) =>
  !ref || !strikes?.length ? null
    : strikes.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a), strikes[0]);

/* ── open interest ───────────────────────────────────────────────────── */

/** Total call/put OI for a session, and the put-call ratio built from them. */
export function oiTotals(chain, prev) {
  let callOI = 0, putOI = 0, dCall = 0, dPut = 0, any = false;
  Object.entries(chain || {}).forEach(([k, r]) => {
    const co = r.co ?? 0, po = r.po ?? 0;
    if (r.co != null || r.po != null) any = true;
    callOI += co; putOI += po;
    const p = prev?.[k];
    if (p) { dCall += co - (p.co ?? 0); dPut += po - (p.po ?? 0); }
  });
  if (!any) return null;
  return { callOI, putOI, dCall, dPut, pcr: callOI ? putOI / callOI : null };
}

/** Per-strike OI with the session-on-session change, for the OI profile. */
export function oiProfile(chain, strikes, prev) {
  return strikes.map((s) => {
    const r = chain?.[String(s)] || {}, p = prev?.[String(s)] || {};
    return {
      strike: s,
      callOI: r.co ?? 0, putOI: r.po ?? 0,
      dCall: (r.co ?? 0) - (p.co ?? 0), dPut: (r.po ?? 0) - (p.po ?? 0),
    };
  });
}

/**
 * Max pain — the strike at which option writers pay out least in total, and so
 * the level the largest open position has the most interest in seeing settle.
 * It is a statement about where money sits, not a forecast.
 */
export function maxPain(chain, strikes) {
  if (!chain || !strikes?.length) return null;
  let best = null, bestPain = Infinity, sawOI = false;
  strikes.forEach((settle) => {
    let pain = 0;
    strikes.forEach((k) => {
      const r = chain[String(k)];
      if (!r) return;
      if (r.co || r.po) sawOI = true;
      pain += (r.co ?? 0) * Math.max(settle - k, 0);   // calls the writer owes
      pain += (r.po ?? 0) * Math.max(k - settle, 0);   // puts the writer owes
    });
    if (pain < bestPain) { bestPain = pain; best = settle; }
  });
  return sawOI ? best : null;
}

/**
 * Synthetic future from put-call parity: F = K + (C − P).
 *
 * This is the forward the options themselves are pricing, and it is the correct
 * reference to solve implied vol against — not the index level. On NIFTY the
 * two routinely differ by a few tenths of a percent, and pricing a chain off
 * spot when the options are quoting a forward 150 points lower makes every deep
 * in-the-money call look like it is trading below intrinsic, which floors its
 * solved vol and pins its delta at 1.00.
 *
 * The median across the strikes nearest the money is used rather than the ATM
 * strike alone: illiquid wings carry NSE's theoretical settlement marks, which
 * imply a different forward, so a single strike is a fragile reading.
 */
export function synthFuture(chain, strikes, ref, span = 5, basis = "settle") {
  if (!chain || !strikes?.length || !ref) return null;
  const near = [...strikes]
    .sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))
    .slice(0, span);
  const fwds = near
    .map((k) => {
      const r = chain[String(k)];
      const c = px(r, "c", basis), p = px(r, "p", basis);
      return c != null && p != null ? k + (c - p) : null;
    })
    .filter((f) => f != null)
    .sort((a, b) => a - b);
  if (!fwds.length) return null;
  const m = Math.floor(fwds.length / 2);
  return fwds.length % 2 ? fwds[m] : (fwds[m - 1] + fwds[m]) / 2;
}

/** ATM straddle premium — the market's own quote for the expected move. */
export function straddlePremium(chain, atm, basis = "settle") {
  const r = chain?.[String(atm)];
  const c = px(r, "c", basis), p = px(r, "p", basis);
  return c != null && p != null ? c + p : null;
}

/** ATM implied vol, averaged across the call and the put at that strike. */
export function atmImpliedVol(chain, atm, spot, T, basis = "settle") {
  const r = chain?.[String(atm)];
  if (!r || !spot || !T) return null;
  const c = px(r, "c", basis), p = px(r, "p", basis);
  const vs = [];
  if (c != null) { const v = impliedVol(c, spot, atm, T, true); if (v) vs.push(v); }
  if (p != null) { const v = impliedVol(p, spot, atm, T, false); if (v) vs.push(v); }
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

/* ── per-strike rows ─────────────────────────────────────────────────── */

/**
 * One row per strike with each side's premium, solved IV and delta. Delta is
 * solved from that strike's own traded premium, so the column reflects what
 * the market actually paid rather than a smooth model curve laid over it.
 */
export function strikeRows(chain, strikes, spot, T, basis = "settle") {
  const open = basis === "open";
  return strikes.map((s) => {
    const r = chain?.[String(s)] || {};
    /* At the open there is simply no price for a contract that had not traded
       yet. Falling back to the settlement would hand back the look-ahead this
       exists to remove, so it stays absent. */
    const out = {
      strike: s,
      c: (open ? r.c0 : r.c) ?? null,
      p: (open ? r.p0 : r.p) ?? null,
      co: r.co ?? 0, po: r.po ?? 0,
      settleC: r.c ?? null, settleP: r.p ?? null,
    };
    if (spot && T > 0) {
      if (out.c != null) {
        out.cIV = impliedVol(out.c, spot, s, T, true);
        out.cDelta = out.cIV ? bsGreeks(spot, s, T, out.cIV, true).delta : null;
      }
      if (out.p != null) {
        out.pIV = impliedVol(out.p, spot, s, T, false);
        out.pDelta = out.pIV ? bsGreeks(spot, s, T, out.pIV, false).delta : null;
      }
    }
    return out;
  });
}

/* ── expiry labelling ────────────────────────────────────────────────── */

const DAY = 86400000;
export const dte = (expiry, today) =>
  Math.max(Math.round((new Date(expiry) - new Date(today)) / DAY), 0);

/**
 * Tag expiries the way a chain does: current week, next week, current month,
 * next month. Monthly is the last expiry falling inside that calendar month,
 * which is how NSE's monthly contract is defined — so this has to be decided
 * against EVERY expiry in the data, not just the handful quoted on the session
 * in view. Judging it from the visible subset would crown whichever expiry
 * happens to be last on screen: with only the 4th and 11th of July loaded, the
 * 11th would be labelled the monthly when the real one is the 25th.
 */
export function tagExpiries(expiries, today) {
  if (!today) return {};
  const future = expiries.filter((e) => e >= today).sort();
  const tags = {};
  if (future[0]) tags[future[0]] = "CW";
  if (future[1]) tags[future[1]] = "NW";

  const monthOf = (d) => d.slice(0, 7);
  const thisMonth = monthOf(today);
  const nextMonth = (() => {
    const d = new Date(today + "T00:00:00");
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 7);
  })();

  const lastIn = (m) => {
    const inM = future.filter((e) => monthOf(e) === m);
    return inM.length ? inM[inM.length - 1] : null;
  };
  const cm = lastIn(thisMonth), nm = lastIn(nextMonth);
  // A weekly tag is the more specific statement, so it wins the label.
  if (cm && !tags[cm]) tags[cm] = "CM";
  if (nm && !tags[nm]) tags[nm] = "NM";
  return tags;
}

/* ── session series ──────────────────────────────────────────────────── */

/**
 * ATM straddle premium across every session of the run-up. Its decay is the
 * clearest single picture of what a premium seller was actually paid for.
 */
export function rollingStraddle(ex, upto, basis = "settle") {
  if (!ex) return [];
  const out = [];
  ex.dates.forEach((d, i) => {
    if (upto != null && i > upto) return;
    const spot = ex.spot[d];
    const atm = atmStrike(ex.strikes, spot);
    const prem = straddlePremium(ex.chain[d], atm, basis);
    if (prem != null) out.push({ date: d, i, spot, atm, premium: prem });
  });
  return out;
}

/**
 * Mark-to-market of the open legs across every session, so the P&L path is
 * visible rather than just its endpoint. Legs are only marked from the session
 * they were entered, and stop moving once closed.
 */
export function mtmSeries(legs, dates, priceOf, lotSizeFor, spotOf) {
  if (!dates?.length || !legs?.length) return [];
  return dates.map((d) => {
    let pnl = 0, marked = false;
    legs.forEach((l) => {
      if (l.entryDate > d) return;
      const closed = l.closedDate && d >= l.closedDate;
      // Each leg is marked against its OWN expiry's chain, so a weekly and a
      // monthly held together are both valued on the same session.
      const px = closed ? l.closePrice : priceOf(l.expiry, d, l.strike, l.right);
      if (px == null) return;
      marked = true;
      const q = l.lots * lotSizeFor(l.entryDate);
      pnl += (l.side === "SELL" ? l.entryPrice - px : px - l.entryPrice) * q;
    });
    return { date: d, pnl: marked ? Math.round(pnl) : null, spot: spotOf(d) };
  });
}

/* ── payoff ──────────────────────────────────────────────────────────── */

/**
 * Payoff across a price range, at expiry and at a target date.
 *
 * `ivShift` scales each leg's own solved IV (0.1 = ten percent higher vol on
 * every leg). The target curve holds that shifted vol constant as spot moves,
 * which is the sticky-strike simplification stated in the UI footnote — a real
 * surface steepens as price falls.
 */
/**
 * Value one leg if the index is at S, with `T` years still to run on that leg.
 *
 * A leg that has reached its own expiry is worth intrinsic against the index —
 * the basis is zero by definition at settlement. A leg still alive is priced
 * off its forward, carried at the basis observed on the session in view.
 */
function legValue(l, S, T, ivShift) {
  const isCall = l.right === "CE";
  const intrinsic = Math.max(isCall ? S - l.strike : l.strike - S, 0);
  const iv = l.iv ? l.iv * (1 + ivShift) : null;
  if (T <= 1e-9 || !iv) return intrinsic;
  return bs(S + (l.basis || 0), l.strike, T, iv, isCall);
}

/**
 * Payoff across a price range, at expiry and at a target date.
 *
 * Legs may sit on different expiries — a weekly sold against a monthly, say —
 * so each carries its own remaining tenor rather than sharing one. `tExp` is
 * the time it still has to run on the payoff's expiry reference date (the
 * NEAREST leg expiry, which is where a calendar's shape is actually decided),
 * and `tTgt` the time it has left on the target date. A leg expiring on the
 * reference date has tExp = 0 and settles at intrinsic; a longer-dated leg
 * keeps time value and is priced for it.
 *
 * `ivShift` scales each leg's own solved IV. Both curves hold that vol constant
 * as spot moves, which is the sticky-strike simplification stated in the UI
 * footnote — a real surface steepens as price falls.
 *
 * `domain` comes from payoffDomain() and is fixed across the session tape, so
 * stepping a day moves the spot marker rather than the whole chart.
 */
export function payoffCurve({ legs, domain, ivShift = 0, points = 141 }) {
  if (!legs?.length || !domain) return [];
  const [lo, hi] = domain;
  if (!(hi > lo)) return [];
  const out = [];
  for (let i = 0; i < points; i++) {
    const S = lo + ((hi - lo) * i) / (points - 1);
    let exp = 0, tgt = 0;
    legs.forEach((l) => {
      const m = l.side === "SELL" ? -1 : 1;
      exp += m * (legValue(l, S, l.tExp ?? 0, ivShift) - l.entryPrice) * l.q;
      tgt += m * (legValue(l, S, l.tTgt ?? 0, ivShift) - l.entryPrice) * l.q;
    });
    out.push({
      S: Math.round(S), exp: Math.round(exp), tgt: Math.round(tgt),
      pos: exp > 0 ? exp : 0, neg: exp < 0 ? exp : 0,
    });
  }
  return out;
}

/** P&L of the given legs at one price on the target date — the target readout. */
export function pnlAt(legs, S, ivShift = 0) {
  let v = 0;
  legs.forEach((l) => {
    v += (l.side === "SELL" ? -1 : 1) * (legValue(l, S, l.tTgt ?? 0, ivShift) - l.entryPrice) * l.q;
  });
  return v;
}

/**
 * The price range the payoff is drawn over.
 *
 * Deliberately independent of the session in view. Deriving it from today's
 * spot and today's sigma made the chart lurch on every step: spot slides the
 * window sideways, and sigma collapses toward expiry, so the last sessions
 * zoomed hard onto a curve that had not actually changed. A payoff is a
 * property of the POSITION, not of the day you look at it from — it should sit
 * still while the spot marker travels across it.
 *
 * The window spans every strike held and every level the index reached over
 * this expiry's sessions, so the whole structure and the whole path stay in
 * frame on every session. It moves only when the book or the expiry changes.
 */
export function payoffDomain({ strikes = [], spots = [], pad = 0.12 }) {
  const pts = [...strikes, ...spots].filter((v) => v != null && v > 0);
  if (!pts.length) return null;
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const margin = Math.max((hi - lo) * pad, lo * 0.025);
  return [Math.round(lo - margin), Math.round(hi + margin)];
}

/** Breakevens: where the expiry payoff crosses zero, by linear interpolation. */
export function breakevens(curve, key = "exp") {
  const out = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if ((a[key] <= 0 && b[key] > 0) || (a[key] >= 0 && b[key] < 0)) {
      const t = Math.abs(a[key]) / (Math.abs(a[key]) + Math.abs(b[key]) || 1);
      out.push(Math.round(a.S + (b.S - a.S) * t));
    }
  }
  return out;
}
