/* Ready-made strategies: the well-known named structures a desk reaches for
   directly, rather than describing a view and letting the ranker search for
   one. Each definition builds real legs from the session's own chain — same
   `leg()` helper the custom finder uses, same solved IVs, same no-arbitrage
   data — so a card never offers a structure the chain cannot actually price.

   The mini chart on each card is a stylised shape, not a live payoff preview:
   the reference this follows reuses one icon across an entire family (Buy
   Call, Sell Put, Bull Call Spread and Bull Put Spread all read the same
   diagonal), because the point of the icon is "which family is this", not a
   pixel-accurate curve — that accuracy belongs to the real chart once the
   structure is loaded. */

import { leg, ok, widths } from "./strategies";

/* Each shape is a polyline in a normalised space: x 0→1 left to right,
   y −1→+1 loss to profit. Rendered with the zero-crossing split into a red
   segment and a green segment, matching the two-tone line in the reference. */
export const SHAPES = {
  bull:        [[0, -0.55], [0.4, -0.55], [1, 0.85]],
  bear:        [[0, 0.85], [0.6, -0.55], [1, -0.55]],
  bullSpread:  [[0, -0.5], [0.32, -0.5], [0.6, 0.65], [1, 0.65]],
  bearSpread:  [[0, 0.65], [0.4, 0.65], [0.68, -0.5], [1, -0.5]],
  ratioUp:     [[0, -0.15], [0.35, -0.55], [0.62, -0.15], [1, 0.9]],
  ratioDown:   [[0, 0.9], [0.38, -0.15], [0.65, -0.55], [1, -0.15]],
  condor:      [[0, -0.5], [0.28, -0.5], [0.44, 0.6], [0.56, 0.6], [0.72, -0.5], [1, -0.5]],
  butterfly:   [[0, -0.4], [0.32, -0.4], [0.5, 0.85], [0.68, -0.4], [1, -0.4]],
  straddleTop: [[0, -0.6], [0.5, 0.8], [1, -0.6]],
  straddleDip: [[0, 0.6], [0.5, -0.85], [1, 0.6]],
  calendar:    [[0, -0.35], [0.3, -0.35], [0.5, 0.35], [0.7, -0.35], [1, -0.35]],
};

/**
 * @param step  the strike grid — 50 on NIFTY, 100 on SENSEX
 * @param k     strikes measured in multiples of that grid off the ATM strike
 */
const w = (step, k) => widths(step, [k])[0];

/* Every builder takes { surf, atm, step, lots } and returns legs or null —
   null when a wing has no traded price, which the card renders as disabled
   rather than loading a partial structure. */
const STRATS = [
  // ── bullish ──────────────────────────────────────────────────────────
  { id: "buy-call", name: "Buy Call", group: "bullish", shape: "bull",
    build: ({ surf, atm, lots }) => ok(leg("BUY", "CE", atm, lots, surf)) },
  { id: "sell-put", name: "Sell Put", group: "bullish", shape: "bull",
    build: ({ surf, atm, lots }) => ok(leg("SELL", "PE", atm, lots, surf)) },
  { id: "bull-call-spread", name: "Bull Call Spread", group: "bullish", shape: "bullSpread",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "CE", atm, lots, surf), leg("SELL", "CE", atm + w(step, 4), lots, surf)) },
  { id: "bull-put-spread", name: "Bull Put Spread", group: "bullish", shape: "bullSpread",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "PE", atm, lots, surf), leg("BUY", "PE", atm - w(step, 4), lots, surf)) },
  { id: "call-ratio-back", name: "Call Ratio Back Spread", group: "bullish", shape: "ratioUp",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "CE", atm, lots, surf), leg("BUY", "CE", atm + w(step, 4), 2 * lots, surf)) },
  { id: "bull-condor", name: "Bull Condor", group: "bullish", shape: "condor",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "PE", atm - w(step, 8), lots, surf), leg("SELL", "PE", atm - w(step, 4), lots, surf),
      leg("SELL", "CE", atm, lots, surf), leg("BUY", "CE", atm + w(step, 4), lots, surf)) },
  { id: "bull-butterfly", name: "Bull Butterfly", group: "bullish", shape: "butterfly",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "CE", atm, lots, surf), leg("SELL", "CE", atm + w(step, 4), 2 * lots, surf),
      leg("BUY", "CE", atm + w(step, 8), lots, surf)) },

  // ── bearish (mirror) ─────────────────────────────────────────────────
  { id: "buy-put", name: "Buy Put", group: "bearish", shape: "bear",
    build: ({ surf, atm, lots }) => ok(leg("BUY", "PE", atm, lots, surf)) },
  { id: "sell-call", name: "Sell Call", group: "bearish", shape: "bear",
    build: ({ surf, atm, lots }) => ok(leg("SELL", "CE", atm, lots, surf)) },
  { id: "bear-put-spread", name: "Bear Put Spread", group: "bearish", shape: "bearSpread",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "PE", atm, lots, surf), leg("SELL", "PE", atm - w(step, 4), lots, surf)) },
  { id: "bear-call-spread", name: "Bear Call Spread", group: "bearish", shape: "bearSpread",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "CE", atm, lots, surf), leg("BUY", "CE", atm + w(step, 4), lots, surf)) },
  { id: "put-ratio-back", name: "Put Ratio Back Spread", group: "bearish", shape: "ratioDown",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "PE", atm, lots, surf), leg("BUY", "PE", atm - w(step, 4), 2 * lots, surf)) },
  { id: "bear-condor", name: "Bear Condor", group: "bearish", shape: "condor",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "PE", atm, lots, surf), leg("BUY", "PE", atm - w(step, 4), lots, surf),
      leg("BUY", "CE", atm + w(step, 8), lots, surf), leg("SELL", "CE", atm + w(step, 4), lots, surf)) },
  { id: "bear-butterfly", name: "Bear Butterfly", group: "bearish", shape: "butterfly",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "PE", atm, lots, surf), leg("SELL", "PE", atm - w(step, 4), 2 * lots, surf),
      leg("BUY", "PE", atm - w(step, 8), lots, surf)) },

  // ── neutral ──────────────────────────────────────────────────────────
  { id: "short-straddle", name: "Short Straddle", group: "neutral", shape: "straddleTop",
    build: ({ surf, atm, lots }) => ok(leg("SELL", "CE", atm, lots, surf), leg("SELL", "PE", atm, lots, surf)) },
  { id: "short-strangle", name: "Short Strangle", group: "neutral", shape: "condor",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "CE", atm + w(step, 4), lots, surf), leg("SELL", "PE", atm - w(step, 4), lots, surf)) },
  { id: "iron-condor", name: "Iron Condor", group: "neutral", shape: "condor",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "CE", atm + w(step, 4), lots, surf), leg("BUY", "CE", atm + w(step, 8), lots, surf),
      leg("SELL", "PE", atm - w(step, 4), lots, surf), leg("BUY", "PE", atm - w(step, 8), lots, surf)) },
  { id: "iron-fly", name: "Iron Butterfly", group: "neutral", shape: "straddleTop",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "CE", atm, lots, surf), leg("SELL", "PE", atm, lots, surf),
      leg("BUY", "CE", atm + w(step, 6), lots, surf), leg("BUY", "PE", atm - w(step, 6), lots, surf)) },
  { id: "long-straddle", name: "Long Straddle", group: "neutral", shape: "straddleDip",
    build: ({ surf, atm, lots }) => ok(leg("BUY", "CE", atm, lots, surf), leg("BUY", "PE", atm, lots, surf)) },
  { id: "long-strangle", name: "Long Strangle", group: "neutral", shape: "straddleDip",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "CE", atm + w(step, 4), lots, surf), leg("BUY", "PE", atm - w(step, 4), lots, surf)) },
  { id: "call-calendar", name: "Long Calendar with Calls", group: "neutral", shape: "calendar",
    build: null /* needs a second expiry — not offered until the wizard can pick two */ },

  // ── others: option-only exotics ─────────────────────────────────────
  { id: "jade-lizard", name: "Jade Lizard", group: "others", shape: "condor",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "PE", atm - w(step, 4), lots, surf),
      leg("SELL", "CE", atm + w(step, 2), lots, surf), leg("BUY", "CE", atm + w(step, 6), lots, surf)) },
  { id: "reverse-jade-lizard", name: "Reverse Jade Lizard", group: "others", shape: "condor",
    build: ({ surf, atm, step, lots }) => ok(
      leg("SELL", "CE", atm + w(step, 4), lots, surf),
      leg("SELL", "PE", atm - w(step, 2), lots, surf), leg("BUY", "PE", atm - w(step, 6), lots, surf)) },
  { id: "bwb-call", name: "Broken Wing Butterfly (Call)", group: "others", shape: "butterfly",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "CE", atm - w(step, 4), lots, surf), leg("SELL", "CE", atm, 2 * lots, surf),
      leg("BUY", "CE", atm + w(step, 8), lots, surf)) },
  { id: "bwb-put", name: "Broken Wing Butterfly (Put)", group: "others", shape: "butterfly",
    build: ({ surf, atm, step, lots }) => ok(
      leg("BUY", "PE", atm + w(step, 4), lots, surf), leg("SELL", "PE", atm, 2 * lots, surf),
      leg("BUY", "PE", atm - w(step, 8), lots, surf)) },
];

export const GROUPS = [
  ["bullish", "Bullish"], ["bearish", "Bearish"], ["neutral", "Neutral"], ["others", "Others"],
];

export function readymadeFor(group) {
  return STRATS.filter((s) => s.group === group);
}

/**
 * Try to build a card's legs against the current chain. Returns null if the
 * structure needs data this bundle does not carry (the calendar, pending a
 * second-expiry picker) or if any wing has no traded price this session —
 * a card that cannot be priced is disabled rather than loaded half-built.
 */
export function buildReadymade(strat, ctx) {
  if (!strat.build) return null;
  return strat.build(ctx);
}
