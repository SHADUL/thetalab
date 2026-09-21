import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  legToMarginOrder,
  buildBasketMarginRequest,
  parseBasketMarginResponse,
  checkMarginSufficient,
} from '../optionsMargin.js';

test('legToMarginOrder maps SELL/BUY sides to Kite transaction_type and defaults product to NRML', () => {
  const sellLeg = legToMarginOrder({ side: 'SELL', tradingsymbol: 'NIFTY26D0325000CE', quantity: 65 }, { exchange: 'NFO' });
  assert.equal(sellLeg.transaction_type, 'SELL');
  assert.equal(sellLeg.exchange, 'NFO');
  assert.equal(sellLeg.product, 'NRML');
  assert.equal(sellLeg.order_type, 'MARKET');
  assert.equal(sellLeg.quantity, 65);

  const buyLeg = legToMarginOrder({ side: 'BUY', tradingsymbol: 'NIFTY26D0324800CE', quantity: 65 }, { exchange: 'NFO', product: 'MIS' });
  assert.equal(buyLeg.transaction_type, 'BUY');
  assert.equal(buyLeg.product, 'MIS');
});

test('buildBasketMarginRequest builds one order per leg and defaults considerPositions to false', () => {
  const legs = [
    { side: 'SELL', tradingsymbol: 'NIFTY26D0325000CE', quantity: 65 },
    { side: 'BUY', tradingsymbol: 'NIFTY26D0325100CE', quantity: 65 },
    { side: 'SELL', tradingsymbol: 'NIFTY26D0324500PE', quantity: 65 },
    { side: 'BUY', tradingsymbol: 'NIFTY26D0324400PE', quantity: 65 },
  ];
  const req = buildBasketMarginRequest(legs, { exchange: 'NFO' });
  assert.equal(req.considerPositions, false);
  assert.equal(req.orders.length, 4);
  assert.deepEqual(req.orders.map((o) => o.transaction_type), ['SELL', 'BUY', 'SELL', 'BUY']);
  assert.ok(req.orders.every((o) => o.exchange === 'NFO' && o.variety === 'regular' && o.order_type === 'MARKET'));
});

test('parseBasketMarginResponse reads final.total when present, falls back to top-level total', () => {
  const withFinal = parseBasketMarginResponse({ final: { total: 45000 }, initial: { total: 60000 }, orders: [] });
  assert.equal(withFinal.totalRequired, 45000);
  assert.equal(withFinal.initialTotal, 60000);

  const withoutFinal = parseBasketMarginResponse({ total: 30000, orders: [] });
  assert.equal(withoutFinal.totalRequired, 30000);
  assert.equal(withoutFinal.initialTotal, null);

  assert.equal(parseBasketMarginResponse(null), null);
});

test('parseBasketMarginResponse normalises per-order fields and keeps the raw response', () => {
  const raw = {
    final: { total: 45000 },
    orders: [{ tradingsymbol: 'NIFTY26D0325000CE', total: 20000, span: 15000, exposure: 5000, option_premium: 12000, additional: 0 }],
  };
  const parsed = parseBasketMarginResponse(raw);
  assert.equal(parsed.perOrder.length, 1);
  assert.equal(parsed.perOrder[0].tradingsymbol, 'NIFTY26D0325000CE');
  assert.equal(parsed.perOrder[0].span, 15000);
  assert.equal(parsed.perOrder[0].optionPremium, 12000);
  assert.equal(parsed.raw, raw);
});

test('checkMarginSufficient refuses (does not guess) when margin or funds data is missing', () => {
  assert.equal(checkMarginSufficient({ totalRequired: null, availableFunds: 100000 }).reason, 'MARGIN_UNKNOWN');
  assert.equal(checkMarginSufficient({ totalRequired: NaN, availableFunds: 100000 }).reason, 'MARGIN_UNKNOWN');
  assert.equal(checkMarginSufficient({ totalRequired: 0, availableFunds: 100000 }).reason, 'MARGIN_ZERO_OR_INVALID');
  assert.equal(checkMarginSufficient({ totalRequired: 45000, availableFunds: null }).reason, 'AVAILABLE_FUNDS_UNKNOWN');
});

test('checkMarginSufficient flags insufficient funds and max-utilization breaches', () => {
  const insufficient = checkMarginSufficient({ totalRequired: 120000, availableFunds: 100000 });
  assert.equal(insufficient.sufficient, false);
  assert.equal(insufficient.reason, 'INSUFFICIENT_FUNDS');

  const overUtilized = checkMarginSufficient({ totalRequired: 60000, availableFunds: 100000, maxUtilizationPct: 50 });
  assert.equal(overUtilized.sufficient, false);
  assert.equal(overUtilized.reason, 'MAX_UTILIZATION_EXCEEDED');
  assert.equal(overUtilized.utilizationPct, 60);
});

test('checkMarginSufficient passes when required margin is within limits', () => {
  const ok = checkMarginSufficient({ totalRequired: 40000, availableFunds: 100000, maxUtilizationPct: 50 });
  assert.equal(ok.sufficient, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.utilizationPct, 40);
});
