import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normCdf, normInv, normPdf } from '../math/normal.ts';
import { black76, impliedVol, forwardFromParity } from '../pricing/black76.ts';

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(
    Math.abs(a - b) <= tol,
    `${msg ?? ''} expected ${a} ≈ ${b} (tol ${tol}, diff ${Math.abs(a - b)})`,
  );

/* ---------------- normal distribution ---------------- */

test('normCdf matches published values to 1e-12', () => {
  close(normCdf(0), 0.5, 1e-15);
  close(normCdf(1), 0.8413447460685429, 1e-12);
  close(normCdf(-1), 0.15865525393145705, 1e-12);
  close(normCdf(1.96), 0.9750021048517795, 1e-12);
  close(normCdf(-3), 0.0013498980316300933, 1e-14);
  // Deep tail: this is where the cheap A&S approximation fails and where
  // tail-risk numbers actually live.
  // Deep tail is checked on RELATIVE error: 1e-20 absolute is below the
  // representable precision of a number this small.
  const tail = normCdf(-6);
  assert.ok(
    Math.abs(tail / 9.865876450376946e-10 - 1) < 1e-8,
    `deep tail relative error too large: ${tail}`,
  );
});

test('normCdf is symmetric and monotone', () => {
  for (let x = -8; x <= 8; x += 0.37) {
    close(normCdf(x) + normCdf(-x), 1, 1e-14);
    assert.ok(normCdf(x) < normCdf(x + 0.01));
  }
});

test('normInv inverts normCdf', () => {
  for (const p of [1e-6, 0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) {
    close(normCdf(normInv(p)), p, 1e-12, `p=${p}`);
  }
});

test('normPdf integrates to ~1 over [-8,8]', () => {
  let sum = 0;
  const h = 1e-3;
  for (let x = -8; x <= 8; x += h) sum += normPdf(x) * h;
  close(sum, 1, 1e-6);
});

/* ---------------- Black-76 pricing ---------------- */

test('ATM Black-76 matches the closed-form reference', () => {
  // F=K=100, T=1, s=0.20, r=0  ->  100*(N(0.1) - N(-0.1)) = 7.965567...
  const c = black76({ forward: 100, strike: 100, timeToExpiry: 1, vol: 0.2, rate: 0, right: 'CE' });
  close(c.price, 7.965567455405804, 1e-10);
  const p = black76({ forward: 100, strike: 100, timeToExpiry: 1, vol: 0.2, rate: 0, right: 'PE' });
  close(p.price, 7.965567455405804, 1e-10, 'ATM call and put are equal when F=K, r=0');
});

test('put-call parity holds across the surface', () => {
  const r = 0.065;
  for (const F of [24000, 24850, 25600]) {
    for (const K of [23000, 24500, 25000, 26500]) {
      for (const T of [1 / 365, 7 / 365, 30 / 365, 0.5]) {
        for (const vol of [0.08, 0.14, 0.35]) {
          const base = { forward: F, strike: K, timeToExpiry: T, vol, rate: r };
          const c = black76({ ...base, right: 'CE' }).price;
          const p = black76({ ...base, right: 'PE' }).price;
          close(c - p, Math.exp(-r * T) * (F - K), 1e-8, `F=${F} K=${K} T=${T}`);
        }
      }
    }
  }
});

test('prices respect arbitrage bounds', () => {
  const base = { forward: 25000, strike: 24000, timeToExpiry: 30 / 365, rate: 0.065 };
  for (const vol of [0.05, 0.15, 0.45, 1.2]) {
    const c = black76({ ...base, vol, right: 'CE' }).price;
    const df = Math.exp(-base.rate * base.timeToExpiry);
    assert.ok(c >= df * (base.forward - base.strike) - 1e-9, 'call above intrinsic');
    assert.ok(c <= df * base.forward, 'call below discounted forward');
  }
});

test('price is monotone increasing in vol', () => {
  const base = { forward: 25000, strike: 25500, timeToExpiry: 7 / 365, rate: 0.065, right: 'CE' as const };
  let prev = -Infinity;
  for (let v = 0.02; v <= 1.5; v += 0.02) {
    const px = black76({ ...base, vol: v }).price;
    assert.ok(px > prev, `not monotone at vol=${v}`);
    prev = px;
  }
});

/* ---------------- Greeks vs finite differences ---------------- */

test('analytic Greeks match central finite differences', () => {
  const cases = [
    { forward: 25000, strike: 25000, timeToExpiry: 7 / 365, vol: 0.12, rate: 0.065 },
    { forward: 25000, strike: 24200, timeToExpiry: 30 / 365, vol: 0.18, rate: 0.065 },
    { forward: 25000, strike: 26000, timeToExpiry: 3 / 365, vol: 0.25, rate: 0.065 },
    { forward: 25000, strike: 27000, timeToExpiry: 60 / 365, vol: 0.4, rate: 0.02 },
  ];

  for (const base of cases) {
    for (const right of ['CE', 'PE'] as const) {
      const g = black76({ ...base, right });
      const px = (o: Partial<typeof base>) => black76({ ...base, ...o, right }).price;

      const dF = base.forward * 1e-5;
      const fdDelta = (px({ forward: base.forward + dF }) - px({ forward: base.forward - dF })) / (2 * dF);
      close(g.delta!, fdDelta, 1e-6, `delta ${right} K=${base.strike}`);

      const fdGamma =
        (px({ forward: base.forward + dF }) - 2 * px({}) + px({ forward: base.forward - dF })) /
        (dF * dF);
      close(g.gamma!, fdGamma, 1e-6, `gamma ${right} K=${base.strike}`);

      const dV = 1e-6;
      const fdVega = (px({ vol: base.vol + dV }) - px({ vol: base.vol - dV })) / (2 * dV);
      close(g.vega!, fdVega, 1e-3, `vega ${right} K=${base.strike}`);

      // theta = -dPrice/dT, reported per calendar day.
      const dT = 1e-7;
      const fdTheta =
        -(px({ timeToExpiry: base.timeToExpiry + dT }) - px({ timeToExpiry: base.timeToExpiry - dT })) /
        (2 * dT) /
        365;
      close(g.theta!, fdTheta, 1e-4, `theta ${right} K=${base.strike}`);
    }
  }
});

test('short options have positive theta once sign is flipped, long options do not', () => {
  const g = black76({ forward: 25000, strike: 25000, timeToExpiry: 5 / 365, vol: 0.13, rate: 0.065, right: 'CE' });
  assert.ok(g.theta! < 0, 'a long option must decay');
  assert.ok(g.gamma! > 0 && g.vega! > 0);
});

test('gamma and vega peak near the money', () => {
  const base = { forward: 25000, timeToExpiry: 7 / 365, vol: 0.13, rate: 0.065, right: 'CE' as const };
  const atm = black76({ ...base, strike: 25000 });
  const otm = black76({ ...base, strike: 26500 });
  assert.ok(atm.gamma! > otm.gamma!);
  assert.ok(atm.vega! > otm.vega!);
});

/* ---------------- Degenerate cases ---------------- */

test('expiry-day and zero-vol collapse to intrinsic without infinities', () => {
  const itm = black76({ forward: 25100, strike: 25000, timeToExpiry: 0, vol: 0.2, rate: 0.065, right: 'CE' });
  close(itm.price, 100, 1e-9);
  assert.equal(itm.degenerate, true);
  close(itm.delta!, 1, 1e-9);
  // Gamma is a Dirac spike at expiry. We return 0 deliberately so net Greeks
  // stay finite; 0-DTE gamma risk is handled by a separate guard, not a number.
  assert.equal(itm.gamma, 0);
  assert.ok(Number.isFinite(itm.theta!) && Number.isFinite(itm.vega!));

  const otm = black76({ forward: 24900, strike: 25000, timeToExpiry: 0, vol: 0.2, rate: 0.065, right: 'CE' });
  close(otm.price, 0, 1e-12);
  close(otm.delta!, 0, 1e-12);

  const zeroVol = black76({ forward: 25100, strike: 25000, timeToExpiry: 0.1, vol: 0, rate: 0, right: 'CE' });
  close(zeroVol.price, 100, 1e-9);
});

test('non-positive forward or strike throws rather than returning NaN', () => {
  assert.throws(() =>
    black76({ forward: 0, strike: 25000, timeToExpiry: 0.1, vol: 0.2, rate: 0, right: 'CE' }),
  );
  assert.throws(() =>
    black76({ forward: 25000, strike: -100, timeToExpiry: 0.1, vol: 0.2, rate: 0, right: 'CE' }),
  );
});

/* ---------------- Implied volatility ---------------- */

test('implied vol round-trips across strikes, tenors and vol levels', () => {
  const rate = 0.065;
  let worst = 0;
  for (const F of [18500, 25000]) {
    for (const K of [F * 0.85, F * 0.95, F, F * 1.05, F * 1.15]) {
      for (const T of [1 / 365, 2 / 365, 7 / 365, 45 / 365, 1]) {
        for (const vol of [0.05, 0.1, 0.18, 0.42, 0.9]) {
          for (const right of ['CE', 'PE'] as const) {
            const priced = black76({ forward: F, strike: K, timeToExpiry: T, vol, rate, right });
            const px = priced.price;
            if (px < 1e-6) continue; // no information content in a zero price
            // Deep-ITM contracts at intrinsic carry no vol information at all;
            // the solver is expected to refuse them, tested separately below.
            if ((priced.vega ?? 0) < 1e-6) continue;
            const solved = impliedVol(px, { forward: F, strike: K, timeToExpiry: T, rate, right });
            assert.ok(
              solved.vol !== null,
              `failed to solve F=${F} K=${K} T=${T} vol=${vol} ${right} px=${px}`,
            );
            // What inversion can guarantee is price reproduction. The vol
            // error it implies is (price tolerance / vega), so the vol
            // tolerance has to be scaled by conditioning rather than fixed.
            const reprice = black76({ forward: F, strike: K, timeToExpiry: T, vol: solved.vol!, rate, right }).price;
            close(reprice, px, 1e-7, `reprice F=${F} K=${K} T=${T} ${right}`);
            const volTol = Math.max(1e-6, (1e-7 / (priced.vega ?? 1)) * 10);
            close(solved.vol!, vol, volTol, `F=${F} K=${K} T=${T} ${right}`);
            worst = Math.max(worst, Math.abs(solved.vol! - vol) / volTol);
          }
        }
      }
    }
  }
  assert.ok(worst <= 1, `worst IV error exceeded its conditioning bound (${worst}x)`);
});

test('implied vol refuses prices that violate arbitrage bounds', () => {
  const args = { forward: 25000, strike: 24000, timeToExpiry: 7 / 365, rate: 0.065, right: 'CE' as const };
  // Below intrinsic — common in bhavcopy settlement prices on illiquid wings.
  const below = impliedVol(500, args);
  assert.equal(below.vol, null);
  assert.equal(below.failure, 'BELOW_INTRINSIC');

  const above = impliedVol(30000, args);
  assert.equal(above.vol, null);
  assert.equal(above.failure, 'ABOVE_MAX');

  assert.equal(impliedVol(0, args).failure, 'NON_POSITIVE_PRICE');
  assert.equal(impliedVol(100, { ...args, timeToExpiry: 0 }).failure, 'EXPIRED');
});

test('implied vol refuses to invent a number when price is insensitive to vol', () => {
  // Deep ITM, 1 DTE: the contract trades at intrinsic and vega underflows.
  // Any vol reproduces the price, so no IV exists. Returning the seed value
  // here would silently feed a fabricated smile into strike selection.
  const args = { forward: 18500, strike: 15725, timeToExpiry: 1 / 365, rate: 0.065, right: 'CE' as const };
  const px = black76({ ...args, vol: 0.05 }).price;
  const solved = impliedVol(px, args);
  assert.equal(solved.vol, null);
  assert.equal(solved.failure, 'ILL_CONDITIONED');
});

test('implied vol converges on deep OTM weeklies where vega is tiny', () => {
  const args = { forward: 25000, strike: 27500, timeToExpiry: 2 / 365, rate: 0.065, right: 'CE' as const };
  const px = black76({ ...args, vol: 0.55 }).price;
  const solved = impliedVol(px, args);
  assert.ok(solved.vol !== null);
  close(solved.vol!, 0.55, 1e-5);
  assert.ok(solved.iterations < 100);
});

/* ---------------- Forward from parity ---------------- */

test('put-call parity recovers the true forward', () => {
  const F = 25137.4;
  const r = 0.065;
  const T = 9 / 365;
  const pairs = [24800, 25000, 25100, 25400].map((strike) => {
    const callMid = black76({ forward: F, strike, timeToExpiry: T, vol: 0.13, rate: r, right: 'CE' }).price;
    const putMid = black76({ forward: F, strike, timeToExpiry: T, vol: 0.13, rate: r, right: 'PE' }).price;
    return { strike, callMid, putMid, weight: strike === 25100 ? 10 : 1 };
  });
  const est = forwardFromParity(pairs, T, r);
  assert.ok(est !== null);
  close(est!.forward, F, 1e-6);
  assert.equal(est!.source, 'parity');
  assert.equal(est!.strikeUsed, 25100);
});

test('forwardFromParity returns null when nothing is usable', () => {
  assert.equal(forwardFromParity([], 0.1, 0.065), null);
});
