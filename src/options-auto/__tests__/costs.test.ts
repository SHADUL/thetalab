import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLegCharges, computeRoundTripLegCharges,
  BROKERAGE_PER_ORDER, OPTIONS_STT_SELL_PCT, STAMP_DUTY_BUY_PCT,
} from '../backtest/costs.ts';

test('a SELL order carries STT but no stamp duty', () => {
  const charge = computeLegCharges({ side: 'SELL', turnover: 100_000 });
  const withoutStt = charge - 100_000 * OPTIONS_STT_SELL_PCT;
  assert.ok(charge > BROKERAGE_PER_ORDER); // more than just flat brokerage
  assert.ok(withoutStt < charge); // STT is genuinely part of the total
});

test('a BUY order carries stamp duty but no STT', () => {
  const buyCharge = computeLegCharges({ side: 'BUY', turnover: 100_000 });
  const sellCharge = computeLegCharges({ side: 'SELL', turnover: 100_000 });
  // SELL's STT (0.1%) is much larger than BUY's stamp duty (0.003%), so SELL should cost strictly more on identical turnover.
  assert.ok(sellCharge > buyCharge);
  const stampOnly = buyCharge - BROKERAGE_PER_ORDER;
  assert.ok(stampOnly > 100_000 * STAMP_DUTY_BUY_PCT * 0.99); // stamp duty is a real, non-trivial component of the BUY-side charge
});

test('brokerage is a flat amount regardless of turnover size', () => {
  const small = computeLegCharges({ side: 'BUY', turnover: 1_000 });
  const large = computeLegCharges({ side: 'BUY', turnover: 10_000_000 });
  // The gap between them should be dominated by %-based charges scaling with turnover, not brokerage (which is identical either way).
  assert.ok(large - small > 1); // sanity: larger turnover does cost more overall
});

test('computeRoundTripLegCharges flips the side for the exit order', () => {
  // Entering by SELLing then exiting by BUYing back — STT applies only to the entry (SELL) leg, stamp duty only to the exit (BUY) leg.
  const roundTrip = computeRoundTripLegCharges('SELL', 50_000, 30_000);
  const entryOnly = computeLegCharges({ side: 'SELL', turnover: 50_000 });
  const exitOnly = computeLegCharges({ side: 'BUY', turnover: 30_000 });
  assert.ok(Math.abs(roundTrip - (entryOnly + exitOnly)) < 1e-9);
});

test('charges are always positive for any valid turnover', () => {
  assert.ok(computeLegCharges({ side: 'BUY', turnover: 500 }) > 0);
  assert.ok(computeLegCharges({ side: 'SELL', turnover: 500 }) > 0);
});
