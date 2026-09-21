/**
 * Kite basket-margin request/response shaping — pure, no network call here
 * (that's api/options-autotrade.ts's `?resource=margin` handler, which
 * needs a live Kite session).
 *
 * Basket margin (`/margins/basket`), not `/margins/orders`, is used
 * deliberately: it nets hedged legs against each other (an iron condor's
 * long wings reduce the margin its short legs would need alone), which is
 * the entire financial point of only ever trading defined-risk structures
 * here rather than naked strangles. `/margins/orders` prices each leg
 * independently and would overstate the true capital requirement.
 *
 * No margin API call exists anywhere else in this codebase today — every
 * order placed so far (api/swing-autotrade*.js) is cash-market CNC equity,
 * which never needed one. The response shape parsed below (`final.total`,
 * `initial.total`, per-order `total`/`span`/`exposure`/`option_premium`)
 * has been verified against a live NIFTY iron-condor basket-margin call
 * (2026-09-21): a 338,903 pre-netting total collapsed to 62,038 post-
 * netting, confirming the hedge-netting benefit these field names claim.
 * The raw response also carries a per-order `charges` breakdown (STT,
 * exchange/SEBI turnover, brokerage, GST) not yet surfaced by
 * parseBasketMarginResponse() — worth pulling in when a realistic net-P&L
 * accounting layer is built, available today via `.raw` in the meantime.
 */

/**
 * @typedef {object} MarginLeg
 * @property {'BUY'|'SELL'} side
 * @property {string} tradingsymbol
 * @property {number} quantity   total quantity (lots * lot_size), not lots
 */

export function legToMarginOrder(leg, { exchange, product = 'NRML' }) {
  return {
    exchange,
    tradingsymbol: leg.tradingsymbol,
    transaction_type: leg.side === 'SELL' ? 'SELL' : 'BUY',
    variety: 'regular',
    product,
    order_type: 'MARKET',
    quantity: leg.quantity,
  };
}

/**
 * @param {MarginLeg[]} legs
 * @param {{exchange?: string, product?: string, considerPositions?: boolean}} [opts]
 */
export function buildBasketMarginRequest(legs, { exchange = 'NFO', product = 'NRML', considerPositions = false } = {}) {
  return {
    considerPositions,
    orders: legs.map((leg) => legToMarginOrder(leg, { exchange, product })),
  };
}

/**
 * Normalises Kite's basket-margin response, tolerating a couple of
 * plausible shapes rather than assuming exactly one — see header on why.
 * Always keeps `raw` so a caller (or a human debugging the first live
 * call) can inspect what actually came back.
 */
export function parseBasketMarginResponse(data) {
  if (!data) return null;
  const totalRequired = data.final?.total ?? data.total ?? null;
  const initialTotal = data.initial?.total ?? null;
  const perOrder = Array.isArray(data.orders)
    ? data.orders.map((o) => ({
        tradingsymbol: o.tradingsymbol ?? null,
        total: o.total ?? null,
        span: o.span ?? null,
        exposure: o.exposure ?? null,
        optionPremium: o.option_premium ?? null,
        additional: o.additional ?? null,
      }))
    : [];
  return { totalRequired, initialTotal, perOrder, raw: data };
}

/**
 * The actual pre-trade gate: refuses rather than sizes down when margin
 * data is missing or ambiguous — a NO_TRADE-shaped result, not a guess.
 * @param {{totalRequired: number|null, availableFunds: number|null, maxUtilizationPct?: number|null}} args
 */
export function checkMarginSufficient({ totalRequired, availableFunds, maxUtilizationPct }) {
  if (totalRequired == null || !Number.isFinite(totalRequired)) {
    return { sufficient: false, reason: 'MARGIN_UNKNOWN' };
  }
  if (totalRequired <= 0) {
    return { sufficient: false, reason: 'MARGIN_ZERO_OR_INVALID' };
  }
  if (availableFunds == null || !Number.isFinite(availableFunds)) {
    return { sufficient: false, reason: 'AVAILABLE_FUNDS_UNKNOWN' };
  }
  if (totalRequired > availableFunds) {
    return { sufficient: false, reason: 'INSUFFICIENT_FUNDS', utilizationPct: (totalRequired / availableFunds) * 100 };
  }
  const utilizationPct = (totalRequired / availableFunds) * 100;
  if (maxUtilizationPct != null && utilizationPct > maxUtilizationPct) {
    return { sufficient: false, reason: 'MAX_UTILIZATION_EXCEEDED', utilizationPct };
  }
  return { sufficient: true, reason: null, utilizationPct };
}
