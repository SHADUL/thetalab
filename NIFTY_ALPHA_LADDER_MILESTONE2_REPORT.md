# Nifty Alpha Ladder — Milestone 2 Report

Pure strategy engine only. No live depth, no WebSocket, no broker orders, no execution simulation of any kind (SHADOW or AUTO). Everything below is deterministic and tested against fixture/synthetic data, per your explicit Milestone 2 scope and clarification that Ambiguities A1/A4 do not block this milestone.

---

## 1. Files created

**Source (16 files, 1,017 lines):**

| File | Lines | Implements |
|---|---|---|
| `src/nifty-alpha-ladder/types.ts` | 155 | All domain types (spec §3–§7 notation) |
| `src/nifty-alpha-ladder/parameters.ts` | 117 | θ₁–θ₃₉ register + `THETA` typed accessors + `FUTURES_DEPTH_FALLBACK_MODE` |
| `src/nifty-alpha-ladder/calendar/signalCalendar.ts` | 53 | Gates 5.1–5.3, weekday/session-window/idempotency-key logic |
| `src/nifty-alpha-ladder/calendar/expirySelection.ts` | 19 | Definition 3.1 (e*(d)) |
| `src/nifty-alpha-ladder/signal/signedArea.ts` | 47 | Shared trapezoidal 𝒜(u), Eq (4.2)/(4.4) |
| `src/nifty-alpha-ladder/signal/largeOrderNet.ts` | 146 | Definition 13.3 (reference threshold), Definition 2.2 (event detection/merge), G1 (Eq 4.1) |
| `src/nifty-alpha-ladder/signal/imbalancePath.ts` | 49 | Definition 2.6, G2 (Eq 4.3), first-crossing (Eq 4.5) |
| `src/nifty-alpha-ladder/signal/alignmentRule.ts` | 37 | sgn_ε, Ψ (Definition 4.1 / Proposition 4.4) |
| `src/nifty-alpha-ladder/signal/variationC.ts` | 44 | 𝒞 (Eq 4.10/4.11) |
| `src/nifty-alpha-ladder/signal/signalEngine.ts` | 128 | Full composition (Eq 4.5–4.11 / Eq 14.1) — mode-agnostic |
| `src/nifty-alpha-ladder/instruments/strikeResolver.ts` | 35 | Definition 3.2 (strike step), 3.3 (ATM) |
| `src/nifty-alpha-ladder/instruments/ladderTemplate.ts` | 56 | Definition 3.4 (template + mirror ℳ), Eq (3.1) atomic resolution |
| `src/nifty-alpha-ladder/risk/payoff.ts` | 60 | Eq (6.6)/(6.7), Proposition 6.3 (new module, not in original tree — flagged in spec §17) |
| `src/nifty-alpha-ladder/sizing/unitSizing.ts` | 12 | Definition 6.1 |
| `src/nifty-alpha-ladder/sizing/quantitySizing.ts` | 28 | Definition 6.2 + structure-proxy leg selection |
| `src/nifty-alpha-ladder/sizing/capitalGate.ts` | 31 | Gate 5.12 / Definition 15.1 (single-account form, per A2) |
| `src/nifty-alpha-ladder/tsconfig.json` | — | Mirrors `src/options-auto/tsconfig.json` exactly |

**Tests (11 files, 732 lines, 76 test cases):** `src/nifty-alpha-ladder/__tests__/{calendar,expirySelection,strikeResolver,ladderTemplate,largeOrderNet,imbalancePath,alignmentRule,variationC,payoff,sizing,workedExample}.test.ts`

**Build wiring:** `package.json` gained `alpha-ladder:test` and `alpha-ladder:typecheck` scripts, same convention as the other three strategy families.

**Not created (correctly, per your explicit exclusions):** no `data/*`, no `execution/*`, no `exit/*`, no `monitor/*`, no `persistence/*`, no `research/*`, no API route, no UI, no database migration. Nothing in this milestone talks to Kite, Groww, or any live market data.

---

## 2. Formulas implemented (spec cross-reference)

- **Reference-threshold recursion** (Def 13.3, Eq 13.2): count-weighted running mean of window quantiles, `N^(m) = N^(m-1)+n_m`, active iff `N ≥ θ2`.
- **Large-order event detection & minute-merge** (Def 2.2): per-(side,price) change detection (new / quantity changed / order-count changed), disappeared levels forgotten, same-minute events summed and stamped at the minute start.
- **G1** (Eq 4.1) and its **signed area 𝒜1** (Eq 4.2), including the partial-final-segment linear interpolation and the "one knot → raw value, zero knots → 0" convention.
- **G2** (Eq 4.3: `ρ_k = (B_k−A_k)/(B_k+A_k)`, 0 on zero denominator) and its **signed area 𝒜2** (same trapezoidal function as G1 — one shared implementation, per the spec's own instruction that both use one formula).
- **First-crossing rule** (Eq 4.5) and **14:30 cutoff rule** (Eq 4.6), both implemented in `signal/imbalancePath.ts` and composed in `signal/signalEngine.ts`.
- **d1/d2** (Eq 4.7/4.8): d1 always from the *area* (never the level); d2 from the crossing *level* (plain `sgn`, not `sgn_ε`) on the crossing path, from the *area* (`sgn_ε`) on the cutoff path.
- **Alignment Ψ** (Def 4.1) and its **closed form** (Prop 4.4), tested explicitly as an invariant.
- **Variation C** (Eq 4.10/4.11): asymmetric bullish→bearish-only reversal, inert (never guesses) when VIX is unavailable.
- **Final direction D**, composed exactly as Eq (14.1)'s operator chain.
- **Expiry selection** (Def 3.1): `e2` when `e1−d ≤ 1 day AND |𝔈(d)|>1`, else `e1`.
- **Strike step** (Def 3.2, derived from listed strikes) and **ATM** (Def 3.3, lower-strike tie-break).
- **4:5:1 ladder template + mirror operator** (Def 3.4): declared bearish template, `ℳ` negates offsets and flips PE↔CE, placement order preserved verbatim in both orientations, atomic single-call resolution (Eq 3.1) that nulls out (not substitutes) an unlisted leg.
- **Payoff** (Eq 6.6/6.7): the four-region piecewise value, max loss/gain/tail value, and **break-evens** (Prop 6.3, including the second break-even that appears for `600≤δ<800`).
- **Unit sizing** (Def 6.1), **quantity sizing** (Def 6.2 + structure-proxy leg selection for a 3-leg structure — sums the SHORT leg only), **capital head-room** (Gate 5.12/Def 15.1, with the "running loss reduces head-room 1:1, running profit does not increase it" asymmetry).

**Explicitly not implemented in this milestone** (by design, per your scope): marketable-limit pricing, fill gates, rollback, reconciliation, monitor/exit lifecycles, persistence, audit logging. These are Milestone 3+.

---

## 3. Parameter registry

All 39 parameters (θ1–θ39) are in `parameters.ts`'s `PARAMETER_REGISTER`, each with `{symbol, name, value, unit, description, sourceSection, version}`, plus a typed `THETA.*` accessor object used by every consuming module — **no literal magic numbers appear anywhere else in the module.** `STRATEGY_VERSION = 'HEDGED133_V3_0'` is exported alongside for future persistence stamping (Milestone 3+). `FUTURES_DEPTH_FALLBACK_MODE` is also declared here per your A1 decision, unused by any Milestone-2 code (recorded now so the name is fixed for Milestone 3).

---

## 4. Test matrix (76 tests, all passing)

| Category | File | Count |
|---|---|---|
| CALENDAR | `calendar.test.ts` | 8 (normal Wednesday, holiday→Thursday fallback, normal-Wednesday-no-fire rejects Thursday, exchange holiday, weekend, non-signal weekdays, session window boundaries, idempotency key) |
| G1 | `largeOrderNet.test.ts` | 12 (quantile warmup, threshold recursion is count-weighted not pooled, classification threshold, quantile computation, new event, changed-event-different-minute, unchanged-does-not-reemit, disappeared-then-reappeared-is-new, same-minute merge/sum, minute-grid knot separation, signed-area worked-example reproduction) |
| G2 | `imbalancePath.test.ts` | 6 (rho calculation, zero-denominator, cumulative path, first-crossing worked-example reproduction incl. "no early crossing," no-crossing-returns-null, signed area) |
| ALIGNMENT | `alignmentRule.test.ts` | 6 (sign tolerance dead-band, aligned bullish→bearish, aligned bearish→bullish, divergent-follows-d1 incl. d2=0, d1=0→undefined, closed-form invariant swept over all d1/d2 combinations) |
| VARIATION C | `variationC.test.ts` | 7 (bullish+calm+weak→bearish, bullish+high-VIX→unchanged, bullish+strong-read→unchanged, bearish-never-reversed, VIX-unavailable→inert, weak-read divergent case, weak-read aligned case) |
| EXPIRY | `expirySelection.test.ts` | 5 (nearest >1 day, nearest ≤1 day with second available, nearest ≤1 day with none available, no future expiries, worked-example 6-day case) |
| ATM | `strikeResolver.test.ts` | 4 (step derivation, step derivation ignoring non-minimal gaps/duplicates, nearest-strike selection, exact-tie-lower-strike) |
| STRUCTURE | `ladderTemplate.test.ts` | 5 (bearish exact 4:5:1 + placement order, bullish exact mirror, ratio preserved at both orientations, null-leg-on-missing-strike, declared placement order literal check) |
| PAYOFF | `payoff.test.ts` | 10 (all four payoff regions, non-negativity sweep, worked-example max-loss/gain/tail/break-even, single break-even, second break-even, no-break-even at bounds) |
| SIZING | `sizing.test.ts` | 15 (unit mode below/at/above one unit, zero/negative allocation, exact ratio scaling, quantity mode, structure-proxy leg selection, head-room loss/profit asymmetry, skip condition, unit/quantity margin checks, no-basket-margin fallback) |
| **WORKED EXAMPLE** | `workedExample.test.ts` | 1 end-to-end replay asserting every stated PDF value in one pass |

---

## 5. Worked-example replay — every value reproduced exactly

All from `workedExample.test.ts`, values compared with floating-point tolerance where the PDF itself only states a rounded figure:

| Value | PDF-stated | Reproduced |
|---|---|---|
| G2 first crossing | 10:12 | ✅ 10:12 |
| G2 crossing value | −9.13 | ✅ −9.13 (±0.01) |
| d2 | −1 | ✅ −1 |
| G1 signed area | ≈7,707,000 contract-seconds | ✅ 7,707,000 (±1) |
| d1 | +1 | ✅ +1 |
| alignment | DIVERGENT | ✅ α=0 |
| D0 | +1 (bullish) | ✅ +1 |
| VIX | 11.87 | ✅ 11.87 |
| Variation C | ACTS | ✅ acted=true |
| final D | −1 (bearish) | ✅ −1 |
| future reference F0 | 24,211.80 | ✅ (stored target = F0−300 = 23,911.80, verified) |
| spot at resolution | 24,137.40 | ✅ |
| ATM | 24,150 | ✅ |
| bearish ladder | Buy 4×24150 PE / Buy 1×23750 PE / Sell 5×23950 PE | ✅ exact |
| allocation | ₹700,000 | ✅ |
| unit budget | ₹340,000 | ✅ |
| units | 2 | ✅ |
| net debit/unit | 225.60 pts | ✅ 225.60 (from the PDF's own hypothetical fills) |
| max loss | ₹33,840 | ✅ |
| max gain | ₹86,160 | ✅ |
| tail P&L | ₹56,160 | ✅ |
| break-even | 24,093.60 | ✅ |

**No expected value was adjusted to make the test pass.** Three genuine implementation bugs were found and fixed *by* this replay (not worked around) — see §7.

---

## 6. Regression results — zero changes to existing strategies

| Suite | Tests | Result |
|---|---|---|
| Options Auto-Trader (`options-auto:test`) | 35 | ✅ all pass |
| Quant engine (`quant:test`) | 419 | ✅ all pass |
| VWAP Scalper (`vwap-scalper:test`) | 189 | ✅ all pass |
| Swing Scanner (`swing:test`) | 105 | ✅ all pass |
| Intraday Trader (`intraday:test`) | 85 | ✅ all pass |
| **Total existing** | **833** | **✅ all pass, unchanged** |

`npm run build` (the frontend) also succeeds unchanged — nothing in this milestone is imported by any existing page yet.

---

## 7. Diff summary (bugs found and fixed during this milestone, via the worked-example replay)

1. **`risk/payoff.ts` — wing-offset unit error.** First draft multiplied the wing parameter by 2 and 4 instead of 1 and 2 (i.e. treated the 200-point wing as if it were a 100-point "step" needing doubling). Caught immediately by the payoff-region tests (expected 600, got 1600) and the worked-example replay. Fixed by correcting the coefficients in `bearishUnitPayoff`.
2. **Test fixture gap in `ladderTemplate.test.ts`.** The bullish-orientation test's `listed` strikes fixture didn't include the strikes the bullish mirror actually needs (24,350 and 24,550) — an incomplete test, not a code bug. Fixed by completing the fixture.
3. **Test misunderstanding in `largeOrderNet.test.ts`.** A test asserted that two same-minute, same-price observations with a changed quantity should produce 2 events; re-reading Definition 2.2 confirms the spec's own rule is that same-minute events at the same (side, price) are merged (summed) into **one** stored event, so the code was right and the test's expectation was wrong. Split into two correct tests: one confirming the same-minute merge (1 event, summed), one confirming a change in a **different** minute correctly produces a second event.

No other implementation bugs surfaced. `signedArea.ts`, `computeG1Area`, `computeG2Area`/`findFirstCrossing`, `selectATM`/`deriveStrikeStep`, `computeUnitModeUnits`, and the full `signalEngine.ts` composition all matched the PDF's stated values on the first pass.

---

## 8. Unresolved items (unchanged from Milestone 1, still blocking Milestone 3)

Per your instructions, these are correctly **not** blocking Milestone 2 (fixture/synthetic data only), but remain open before any live-data code is written:

- **A1**: confirmed decision — nearest NIFTY futures depth, named `FUTURES_DEPTH_FALLBACK_MODE`, never represented as the PDF's own proprietary spot source. Recorded in `parameters.ts`; not yet used (no live data in this milestone).
- **A3**: futures exit-repricing schedule remains genuinely unspecified in the source PDF — deferred, not invented, per your instruction.
- **A4**: live depth collection deferred to a separate always-on worker (not Vercel serverless) — not built in this milestone, as instructed.
- **A7**: India VIX 15-minute bar-granularity verification deferred to Milestone 3, as instructed.

---

## 9. What's next

Per your instruction, **stopping here**. Not starting Milestone 3, not building the live depth collector, not implementing SHADOW fills, not implementing AUTO. Awaiting your review of this report before proceeding.
