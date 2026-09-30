# Nifty Alpha Ladder — Spec Reconstruction

Source: `hedged133_strategy_details.pdf` — "Nifty Alpha Ladder", strategy identifier `hedged133`, Optibase Financial Technologies Pvt Ltd, Version 3.0, 28 September 2026 (45 pages). This document is a faithful reconstruction of that PDF's rules for the purpose of implementing them inside thetalab. Where the PDF is the authority, this document cites its section. Where thetalab's own architecture requires a decision the PDF does not make (thetalab is single-account; the PDF is written for a multi-tenant subscriber platform), that decision is called out explicitly in §12 (Ambiguities) and is **not yet resolved**.

No code has been written. This is the first milestone deliverable only (per your instruction, §53).

---

## 1. What the strategy is

- **Underlying**: NIFTY 50 index.
- **Instrument**: NIFTY weekly index options (the resolved expiry, §4 below) plus one companion NIFTY futures position (the "monitor leg").
- **Structure**: a three-strike, three-leg **4:5:1 ratio ladder**, net debit, fully bracketed (non-negative expiry value everywhere — no unbounded tail either side).
- **Signal**: computed **once per week**, on Wednesday (Thursday only as an exchange-holiday fallback), from two independent summaries of the NIFTY order book, reconciled by an alignment rule, then passed through a one-directional volatility filter ("Variation C").
- **Holding period**: multi-day. Entry Wednesday (or Thursday fallback) → exit on the monitor leg's futures-price target event, or forced exit the following Tuesday 15:10 IST, or a 15:20 IST safety sweep, whichever occurs first. At most 6 calendar days / 4 trading sessions after entry.
- **In-trade management**: **none**. No stop, no target, no trailing, no rolling, no re-centring, no delta hedge, no partial profit-taking on the structure itself. The structure's fate is entirely coupled to the monitor futures leg and the clock.
- **The PDF explicitly states** (§2) that Nifty Alpha Ladder is "one of four option structures that share a single weekly directional decision" — a family of four sibling structures plus the monitor leg, all sharing the same direction `D`. **We are building only Nifty Alpha Ladder and its monitor leg — not the other three siblings.** See §12, Ambiguity A1.

---

## 2. Parameter register — θ₁ through θ₃₉ (PDF Table 1.1 / Appendix A)

Every constant below is **exact**, taken verbatim from Appendix A. None are to be treated as tunable defaults; per your instruction (§47/§48) they are read-only in the UI initially.

| Symbol | Name | Value | Unit | Role (PDF §) |
|---|---|---|---|---|
| θ₁ | Large-order quantile level | **0.85** | quantile | Quantile of per-window displayed level-size distribution folded into the large-order reference threshold (§1, Def 13.3) |
| θ₂ | Large-order threshold warm-up count | **150,000** | depth observations | Minimum cumulative level observations before large-order classification activates for a contract (§1, Def 2.2/13.3) |
| θ₃ | Large-order reference window | **15** | minutes | Width of successive aggregation windows whose quantiles are folded into the reference threshold (§1, Def 13.3) |
| θ₄ | Aggregate-imbalance snapshot interval | **3** | minutes | Width of the interval over which full-book bid/ask quantities are aggregated into one G₂ snapshot (§1, Def 2.6) |
| θ₅ | Imbalance-ratio crossing level | **9.0** | cumulative-ratio units | Absolute level of G₂ whose first attainment fires the signal before cutoff (§1, Eq 4.5) |
| θ₆ | Sign tolerance | **1×10⁻⁴** | area units | Dead-band below which a signed area is neutral in `sgn_ε` (§1, Def 2.4) |
| θ₇ | Calm-regime volatility cutoff | **12.5** | India VIX points | VIX (at signal bar) below which Variation C may act (§1, Eq 4.11) |
| θ₈ | Strong-read level | **4.5** | cumulative-ratio units | \|G₂\| at signal instant below which the order-flow read is "weak" for Variation C (§1, Eq 4.10) |
| θ₉ | Volatility bar granularity | **15** | minutes | India VIX bar width; latest bar at/before signal instant is v* (§1, Def 2.1) |
| θ₁₀ | Monitor-leg recommendation band | **0.5%** | of F₀ | Indicative band published with the monitor call (informational only) |
| θ₁₁ | Structure recommendation band | **5%** | of first-leg premium | Indicative band published with the structure call (informational only) |
| θ₁₂ | Marketable-limit proportional buffer | **8%** | of LTP | Proportional distance through the touch for every option limit order (§7, Eq 7.1) |
| θ₁₃ | Marketable-limit absolute floor | **₹3.00** | ₹ per option unit | Minimum absolute buffer; dominates θ₁₂ on low premiums (§7, Eq 7.1) |
| θ₁₄ | Inter-leg release spacing | **750** | ms | Pause between a leg's confirmed fill and release of the next leg (§7, Def 7.4) |
| θ₁₅ | Fill-gate broker-phase cap | **75** | seconds | Max time an entry leg may be un-terminal while not yet OPEN at the exchange (§7, Def 7.4) |
| θ₁₆ | Fill-gate exchange-phase cap | **45** | seconds | Additional time once observed OPEN at the exchange (§7, Def 7.4) |
| θ₁₇ | Fill-gate absolute ceiling | **100** | seconds | Hard cap from placement regardless of phase (§7, Def 7.4) |
| θ₁₈ | Order-book read schedule | **{0.5, 1.2, 2.5, 5, 8}** | seconds after placement | Front-loaded reads before the sparse cadence begins (§7, Def 7.4) |
| θ₁₉ | Sparse read period | **12** | seconds | Read cadence after the front-loaded schedule is exhausted (§7, Def 7.4) |
| θ₂₀ | Read back-off | **20** | seconds | Minimum delay before the next read after a failed read (§7, Def 7.4) |
| θ₂₁ | Session-recovery budget | **4** | recoveries | Max session-token recoveries per gate/monitor before treated non-transient (§7, Def 7.3) |
| θ₂₂ | Same-day entry cap | **3** | trade events | Max same-day trade events per subscriber per algo (Gate 5.11) — **see Ambiguity A2 (subscriber model)** |
| θ₂₃ | Conflict-query timeout | **5** | seconds | Timeout of per-subscriber opposite-position query; fails open (Gate 5.9) |
| θ₂₄ | Rollback status-lookup window | **45** | seconds | Window over which rollback retries the order-status read of each placed leg (§7, Def 7.5) |
| θ₂₅ | Rollback re-check window | **20** | seconds | Window over which status is re-read after a blind cancel (§7, Def 7.5) |
| θ₂₆ | Cancel settle delay | **4** | seconds | Delay between a rollback cancel and re-reading status (§7, Def 7.5) |
| θ₂₇ | Exit short-close gate | **60** | seconds | Max wait for a short leg's buy-to-close to reach COMPLETE before longs may release (§9, Def 9.4) |
| θ₂₈ | Exit order-fetch retry budget | **5** | attempts | Attempts (linear back-off) to read a leg's open ledger rows before an exit aborts in full (§9, Def 9.4) |
| θ₂₉ | Exit-monitor first-check interval | **[10, 20]** | seconds (uniform random) | First status check of a resting exit limit order (§9, Def 9.5) |
| θ₃₀ | Exit re-pricing schedule Φₓ(i) | **2.5% (i<5), 5% (5≤i<12), 10% (i≥12)** | fraction of LTP | Escalating buffer at the i-th re-pricing of a resting option exit (§9, Eq 9.2) |
| θ₃₁ | Late-session stretch schedule Φ_ℓ(i) | **18% (i<5), 24% (5≤i<12), 30% (i≥12)** | fraction of LTP | Floor applied to Φₓ(i) after 15:20 (§9, Eq 9.2) |
| θ₃₂ | Scheduled-exit attempt budget | **5** | attempts | Attempts of the 15:10 force-exit and of the 15:20 safety-net exit before an unsettled alert (§9, Def 9.1/9.2) |
| θ₃₃ | Scheduled-exit retry interval | **2** | minutes | Interval between scheduled force-exit attempts (§9, Def 9.1) |
| θ₃₄ | Post-trade synchroniser delay | **3** | minutes | Delay after entry/exit at which reconciliation runs; second pass one further delay later (§7/§9) |
| θ₃₅ | Leftover-check delay | **12** | minutes | Delay after a call's exit time at which the ledger is checked for an unlinked leg (§9) |
| θ₃₆ | Leftover-check look-back | **90** | minutes | Look-back horizon for closed-but-unverified calls (§9) |
| θ₃₇ | Leftover-check attempt budget | **3** | attempts | Attempts before a call is reported unverifiable (§9) |
| θ₃₈ | Broker-position cache lifetime | **10** | seconds | Lifetime of a per-subscriber broker-positions read shared across the legs of one exit (§9, Def 9.3) |
| θ₃₉ | Structure unit margin | **₹340,000** | ₹ per structure unit | Capital budget for one complete unit of the whole ratio basket; used for unit-mode sizing (§6, Def 6.1) |

---

## 3. Notation and information set (PDF §3)

All times IST. Adapted processes:

| Symbol | Meaning | Granularity |
|---|---|---|
| `S_t` | NIFTY 50 index level | tick / LTP |
| `F_t` | Price of the nearest NIFTY index future (used by the monitor leg) | tick stream |
| `V_t` | India VIX bars, width θ₉ | 15-min bars |
| `ℒ_t^b`, `ℒ_t^a` | Depth ladders (price, quantity, order count) — bid/ask sides of "the NIFTY book" | depth snapshots — **see Ambiguity A1: which real instrument's book this is** |
| `𝔅_t^b`, `𝔅_t^a` | Large-order event sets (Definition 2.2) | event stream |
| `(B_k, A_k, t_k)` | Aggregate bid/ask quantity snapshots, width θ₄ | batched every θ₄ |
| `C_t(K,e,ω)` | Last traded premium of option (strike K, expiry e, type ω∈{CE,PE}) | quote on demand |

**Clock lattice (Definition 2.1)**: signal evaluation instants `𝕋_d = {09:31, 09:32, …, 14:31}` (every minute) on the signal day `d`. Session cutoff `T_c = 14:30`. Scheduled exit `τ_x^sched = Tuesday 15:10`. Safety-net exit `τ_x^safety = Tuesday 15:20`. Market-hours window for price-triggered exits `𝕄 = [09:15, 15:30]` on trading days.

**Direction encoding (Definition 2.4)**: `d ∈ {+1 (bullish), −1 (bearish), 0 (neutral)}`. `sgn_ε(x) = +1` if `x > θ₆`, `−1` if `x < −θ₆`, else `0`.

**Units and lots (Definition 2.5)**: `L` = exchange NIFTY-options lot size. A structure unit = one complete basket at the declared ratio (vector `u = (u₁,…,u_n)` × `L`). `n_u` units of subscriber → `n_u · u_i · L` contracts of leg `i`.

**Information set**: at evaluation instant `t`, all signal quantities are functions of `𝓕_t` (everything persisted by `t`) — pure, causal, no look-ahead — **except** India VIX, which is read exactly once, at the decision instant `t_f ≥ τ*`: the close of the latest VIX bar timestamped **at or before** `τ*`, as returned at `t_f`.

**Two independent grids**: G₁ lives on a **minute grid** (event times rounded to whole minutes); G₂ lives on the **θ₄-aggregation grid** `{t_k}`. They are never sample-aligned — all comparisons between the two paths go through time-integrals or through values-at-a-common-instant, never through aligning samples.

**Storage latency**: persistence of both series happens in periodic batches, so what the evaluator can actually see at wall-clock `t` is `𝓕_{t−λ}` for a small non-negative latency `λ`. The evaluator never reads a sample stamped after the evaluation instant.

---

## 4. Universe and instrument selection (PDF §4)

All legs of one structure are resolved **atomically in one query** sharing one expiry and one ATM reference — never leg-by-leg (the spot could move between requests and key different legs to different ATM strikes).

**Definition 3.1 — Expiry selection.**
Let `𝔈(d) = {e₁ < e₂ < …}` = listed NIFTY option expiries strictly after date `d`.

```
e*(d) = e₂  if (e₁ − d) ≤ 1 calendar day AND |𝔈(d)| > 1
e*(d) = e₁  otherwise
```

On a normal Wednesday with the standard Tuesday weekly expiry, `e*(d)` is the *following* Tuesday (6 days out) — the near Tuesday (1 day out) is skipped by the `≤1 day` rule. The scheduled force-exit therefore lands on the traded series' own expiry day, before the close.

**Definition 3.2 — Strike step.**
`𝒦(e) = {K₁ < K₂ < … < K_m}` = distinct listed strikes of expiry `e`. `Δ(e) = min_j(K_{j+1} − K_j)` over positive gaps. For NIFTY weekly near the money this is **50** — but it must be **derived from the actual listed strike ladder each time**, never hard-coded (your instruction §12 agrees with the PDF here).

**Definition 3.3 — ATM strike.**
`K_ATM(S,e) = argmin_{K∈𝒦(e)} |K − S|`, ties → **lower strike** (scan-order tie-break).

**Definition 3.4 — Leg template and mirror operator.**
Declared once, in **bearish orientation**: ordered legs `ℓ_i = (o_i, u_i, s_i)` — offset in strike steps from ATM, unit ratio, side ∈ {Buy, Sell} — plus bearish option type `ω⁻`. For Nifty Alpha Ladder, `ω⁻ = PE`.

Mirror operator `ℳ`: `ℳ(o_i) = −o_i`, `ℳ(ω⁻)` = the other type (PE↔CE). Resolved leg for direction `D`:
```
o_i^(−1) = o_i          (bearish: offsets as declared)
o_i^(+1) = −o_i         (bullish: offsets negated)
ω^(−1) = ω⁻ = PE
ω^(+1) = ℳ(ω⁻) = CE
```

**Resolution**: `𝓡(D,d,S) = ((K_ATM(S,e*) + o_i^(D)·Δ(e*), e*(d), ω^(D)))_{i=1..n}`. Returns, per leg, either the listed contract (symbol, exchange token, lot size, LTP) or `null`. **If any leg is null, the structure is not created for that day** — a local failure that does not affect the monitor leg or (in the full PDF family) sibling structures.

**Per-leg call quantity (Def 3.5)**: `Q_i = u_i · L` for one unit; the execution layer multiplies by the subscriber's unit count `n_u`.

**Monitor leg**: nearest NIFTY index future, **one lot**, direction `D`, reference price `F₀` = the future's LTP at call creation. Not part of the option structure's position — its price path defines the structure's *primary* exit event.

---

## 5. Signal construction (PDF §5) — the core decision engine

Computed **at most once per signal week**. Runs on every lattice instant `t ∈ 𝕋_d` until it fires. Pure function of `𝓕_t`, except the VIX read (once, at `t_f`).

### 5.1 Feature G₁ — cumulative large-order net

Merged large-order events (Definition 2.2, below) up to `t`, indexed by distinct timestamps `s₁ < s₂ < …` with aggregated bid size `b_j` and ask size `a_j` at `s_j`:

```
G₁(s_j) = Σ_{r≤j} (b_r − a_r)                                          (4.1)
```

Piecewise-constant, observed at event times (minute grid). **Signed time-integral** up to instant `u` (trapezoidal rule on observed knots, linear interpolation of the final partial segment):

```
𝒜₁(u) = Σ_{j: s_j<u} ½·(G₁(s_j) + G̃₁(min(s_{j+1},u))) · (min(s_{j+1},u) − s_j)
G̃₁(x) = G₁(s_j) + (G₁(s_{j+1}) − G₁(s_j))·(x − s_j)/(s_{j+1} − s_j)      (4.2)
```
with `𝒜₁(u) = G₁(s₁)` if exactly one knot ≤ u, and `𝒜₁(u) = 0` if none. **Time in seconds.**

**Critical**: `d₁` is computed from the **signed area** `𝒜₁`, never from the instantaneous level of `G₁`. Persistent pressure outweighs a recent spike. Do not simplify to "current net large-order quantity."

### Definition 2.2 — Large-order event (detail, needed to build G₁)

For side `σ ∈ {b,a}`, `q̂_σ(t)` = the reference threshold (Definition 13.3, below): a **count-weighted running average of θ₁-quantiles of displayed level size**, computed over successive θ₃-length aggregation windows, **active only once ≥ θ₂ level observations have been folded into it**.

A depth level `(p, x, n)` (price, displayed quantity, order count) observed at time `t` on side `σ` is a **large-order level** iff `x > q̂_σ(t)`.

A large-order **event** is recorded only when:
- the level is **new at price p**, OR
- its **quantity changed**, OR
- its **order count changed**

since the previous snapshot (change detection is **per price level**). A level that **disappears is forgotten** — its reappearance is a brand-new event, not a continuation.

**Merging before persistence**: events of the same **side + price + clock minute** are merged (quantities and order counts **summed**) and stamped at the **start of that minute**. So stored event times are always whole minutes. Events sharing a stored timestamp are then merged again, by side (giving the `b_j`/`a_j` used in 4.1).

### Definition 13.3 — Reference threshold recursion (the θ₁/θ₂/θ₃ estimator)

Partition time into consecutive windows `W_m` of length θ₃ (15 min). For side σ, let `n_m` = number of level observations in `W_m`, `ξ_m^σ` = the empirical θ₁-quantile (0.85) of displayed level size within `W_m`.

```
q̂_σ^(m) = (N^(m−1)·q̂_σ^(m−1) + n_m·ξ_m^σ) / (N^(m−1) + n_m)
N^(m) = N^(m−1) + n_m
classification active iff N^(m) ≥ θ₂                                    (13.2)
```

This is a **weighted mean of per-window quantiles**, NOT the quantile of the pooled sample. It adapts slowly once N is large. The threshold used to classify a level at `t` is the one loaded from windows **completed before t** — `q̂_σ(t)` is predictable (𝓕_{t−}-measurable): the classification of a level never uses the level itself.

### 5.2 Feature G₂ — cumulative aggregate book imbalance

**Definition 2.6 — Snapshot construction.** `(s_k, e_k]` = k-th aggregation interval of width θ₄ (3 min); endpoints set by the aggregation clock, **not aligned to the clock minute**. Within the interval, a bid level is admitted to multiset `𝔇ᵇ_k` **each time** its price is first seen in the interval **or** its (quantity, order-count) pair differs from the last admitted state at that price (`𝔇ᵃ_k` symmetric for asks). So a level refreshed multiple times in one interval contributes **once per refresh**, not once per interval.

```
B_k = Σ_{ℓ∈𝔇ᵇ_k} x_ℓ,   A_k = Σ_{ℓ∈𝔇ᵃ_k} x_ℓ,   snapshot stamped t_k = e_k
```

```
ρ_k = (B_k − A_k)/(B_k + A_k)   if B_k+A_k > 0,  else 0
G₂(t_k) = Σ_{r≤k} ρ_k                                                    (4.3)
𝒜₂(u) = trapezoidal signed integral of G₂ up to u, as (4.2)              (4.4)
```

Each `ρ_k ∈ [−1,1]` — G₂ is a bounded-increment random walk.

**Fallback (spot → futures)**: when the primary/spot imbalance document for the day is not yet populated, the **futures-book** imbalance document for NIFTY is used instead; the large-order series has the same spot→futures fallback. **See Ambiguity A1** — what "the primary spot... document" actually is, given NIFTY the index has no order book of its own.

### 5.3 Signal instant — crossing path vs cutoff path

```
τ_× = min{ t_k : t_k ≤ t, |G₂(t_k)| ≥ θ₅ }                                (4.5)
τ* = τ_×  if t < T_c and τ_× exists
τ* = T_c  if t ≥ T_c
τ* undefined otherwise (no fire)                                         (4.6)
```

- **Crossing path**: fires at the **first minute** the cumulative ratio has reached θ₅=9.0 in absolute value (the crossing sample itself may be stamped earlier in the session; the *lattice evaluation* that notices it must be ≥ 09:31).
- **Cutoff path**: reached only if G₂ never crossed before 14:30 — decision taken at `T_c = 14:30`.

**Component directions at τ\*:**
```
d₂ = sgn(G₂(τ_×))        on crossing path       (level, not area)
d₂ = sgn_ε(𝒜₂(T_c))      on cutoff path         (area)
d₁ = sgn_ε(𝒜₁(τ*))                              (always the AREA)      (4.7)(4.8)
```

If `d₁ = 0`: direction unresolved, **nothing is recorded**, engine re-evaluates at the next lattice instant.

### 5.4 Alignment resolution Ψ (Definition 4.1) — "one of the defining features"

```
Ψ(d₁,d₂) = undefined         if d₁ = 0
Ψ = −d₁, α = 1 (aligned)      if d₁ = d₂
Ψ = d₁,  α = 0 (divergent)    if d₁ ≠ d₂  (including d₂ = 0)
D₀ = Ψ(d₁,d₂)                                                              (4.9)
```

**Aligned → fade** (base direction is the *opposite* of the agreeing sign — "exhaustion hypothesis"). **Divergent → follow the large-order path** (`d₁` — "footprint hypothesis"). Closed form (Proposition 4.4): `Ψ(d₁,d₂) = d₁·(1 − 2·𝟙{d₁=d₂})` for `d₁≠0`.

### 5.5 Variation C — the volatility-conditioned contrarian filter

Let `v*` = close of the **latest India VIX bar timestamped at or before τ\***, as returned at the decision instant `t_f` (a bar with non-positive close is ignored). `χ ∈ {0,1}` = whether such a value could be read (`χ=0` on any data failure or no positive close at/before τ*). Let `g* = G₂` at the last snapshot at/before τ*.

```
W = (α = 0) ∨ (|g*| < θ₈)                                                  (4.10)
D = −1  if D₀=+1 ∧ χ=1 ∧ v*<θ₇ ∧ W
D = D₀  otherwise                                                          (4.11)
```

**This is strictly asymmetric**: only a **bullish** base decision can be reversed, and only to **bearish**. Bearish decisions are **never** filtered. When `χ=0` (VIX unreadable), the filter is **inert** — trade `D₀` unfiltered — it never guesses a VIX value. The filter reads VIX **at the signal bar only**, never the session close (unknowable at decision time).

**Decision table** (`d₁ ≠ 0`, from PDF §5):

| d₁ | d₂ | α | D₀ | Variation C may act? | Final D |
|---|---|---|---|---|---|
| +1 | +1 | 1 | −1 | no (base already short) | −1 |
| −1 | −1 | 1 | +1 | yes: W iff \|g*\|<θ₈ | −1 if v*<θ₇∧W∧χ; else +1 |
| +1 | −1 or 0 | 0 | +1 | yes: W holds (α=0 always true) | −1 if v*<θ₇∧χ; else +1 |
| −1 | +1 or 0 | 0 | −1 | no (base already short) | −1 |

**Proposition 4.2**: because `|ρ_k|≤1`, `|G₂(t_k)|≤k`; a crossing at θ₅ cannot occur before the `⌈θ₅⌉`-th snapshot — i.e. roughly the first `⌈9⌉·3min ≈ 27 min` of the session is arithmetically incapable of crossing, regardless of order flow.

**Proposition 4.3**: on the crossing path, `|g*|≥θ₅=9.0 ≥ θ₈=4.5`, so the *strength* clause of W can never hold on the crossing path — W reduces to `α=0` there. On the cutoff path both clauses are live.

**Signal persistence**: once `D₀` is defined, the **full signal record is persisted under the week's idempotency key BEFORE any call is created** — τ*, both component directions, both areas, crossing flag/time/value, G₂(τ*), G₁(τ*), α, v*, χ, D₀, D, source datasets used (spot vs futures fallback), created timestamp.

---

## 6. Regime / eligibility gates (PDF §6)

Product of calendar, data, idempotency, instrument, and per-subscriber gates.

| Gate | Condition | Failure semantics |
|---|---|---|
| 5.1 Exchange trading day | `𝟙_H(t)=1` iff NSE trading day (compiled holiday calendar) | no evaluation on holidays |
| 5.2 Signal weekday + holiday fallback | Wednesday, **or** Thursday **only if** the preceding Wednesday produced **no** aggregate-imbalance data in either spot or futures source (i.e. wasn't a trading session) | a normal Wednesday with no fire does **not** open Thursday — at most one signal day/week |
| 5.3 Session window | `09:31 ≤ t ≤ 14:31` | polled every minute of 𝕋_d |
| 5.4 Weekly idempotency | κ(d) = calendar date of the Wednesday of the signal week (even on Thursday fallback); no-op if a signal record with key κ(d) already exists | after first successful persist, every later evaluation this week is a no-op |
| 5.5 Data sufficiency | large-order series AND imbalance series both non-empty (after fallback) | — |
| 5.6 Directional resolvability | τ* defined AND d₁≠0 | — |
| 5.7 Structure resolvability + daily uniqueness | every leg of 𝓡(D,d,S) resolves to a listed contract, AND no call of this algo exists yet today | structure not published; monitor/siblings unaffected. **χ is NOT a gate** — if VIX is unreadable the structure still publishes, in direction D₀ |
| 5.8 Cross-algorithm call conflict | serialised under a DB advisory lock; new call's legs compared against every other algorithm's OPEN calls; if another algo holds the same contract in the opposite direction, subscribers Live on **both** algos are excluded from the new call (others proceed) | prevents a subscriber holding offsetting positions across algos that broker nets to zero |
| 5.9 Per-subscriber opposite-position check | order-ledger query for existing opposite-direction position on any of the structure's contracts; timeout θ₂₃, **fails open** | Gate 5.8 already covers the structural case |
| 5.10 Subscription and session | subscription Live AND authenticated (live broker session token) | — |
| 5.11 Same-day activity cap | same-day trade count on this algo < θ₂₂ (3) | skip |
| 5.12 Capital head-room and margin | see below | skip |

**Gate 5.12 detail (Definition 15.1)**: `H_u = min(C_u+π_u, C_u)` (deployed capital + running P&L, capped at deployed capital — a running **loss reduces head-room 1:1**, a running **profit does not increase it**). Subscriber skipped if `I_u ≥ H_u > 0`. Then:
- **Unit mode**: `⌊I^alloc_u / θ₃₉⌋ ≥ 1`.
- **Quantity mode**: broker-quoted margin of a **structure proxy** ≤ `H_u − I_u`. Proxy = quote for leg 1 at size `n_u·Q₁` if the structure has 2 legs; sum of quotes for every **short** leg at size if >2 legs (our ladder has 3 legs → sum of short-leg quotes, i.e. just leg 3 since only one leg is short).
- **No basket-margin quote available**: compare broker funds against `n_u · θ₃₉`.

**No event-calendar gate, no separate IV skip gate.** Volatility enters *only* through Variation C. No trend/range filter beyond the order-flow composite. This is explicit design, not an omission.

---

## 7. Position construction and sizing (PDF §7)

### Leg template (bearish orientation; bullish = mirror `ℳ`)

| Placement order | Side | Type | Offset (steps) | Offset (points) | Ratio `u_i` |
|---|---|---|---|---|---|
| 1 | **Buy** | PE | 0 | ATM | **4** |
| 2 | **Buy** | PE | −8 | −400 | **1** |
| 3 | **Sell** | PE | −4 | −200 | **5** |

Bullish mirror: Buy 4× ATM CE, Buy 1× CE +400, Sell 5× CE +200 — **same placement order** (long, long, short).

### Piecewise expiry value, per unit, bearish orientation (index points; A = K_ATM, δ = net debit/unit at fills)

```
V⁻(S_T) = 4·(A−S_T)⁺ − 5·(A−200−S_T)⁺ + (A−400−S_T)⁺                     (6.6)
```

| Region of `S_T` | `V⁻(S_T)` | Edge values |
|---|---|---|
| `S_T ≥ A` | 0 | 0 |
| `A−200 ≤ S_T < A` | `4·(A−S_T)` | rises 0 → 800 |
| `A−400 ≤ S_T < A−200` | `1000 − (A−S_T)` | falls 800 → 600 |
| `S_T < A−400` | 600 | constant |

```
V⁻ ≥ 0 ∀S_T;   max loss = n_u·L·δ;   max gain = n_u·L·(800−δ) at S_T=A−200;   tail value = n_u·L·(600−δ)   (6.7)
```

Slope sequence `(0, −4, +1, 0)` — contract-balanced (5 long vs 5 short overall), no naked exposure in either tail.

**Break-evens (Proposition 6.3)**: for `0<δ<600`, single break-even at `S_T = A − δ/4`; for `600≤δ<800`, a **second** break-even appears at `S_T = A − 1000 + δ` (P&L negative again beyond it). The debit determines whether the far tail is profitable.

### Sizing (per subscriber `u` — see Ambiguity A2 on collapsing "subscriber" to the single account)

- **Unit mode (Def 6.1)**: if allocated capital `I^alloc_u > 0` exists, `n_u = ⌊I^alloc_u / θ₃₉⌋` (θ₃₉ = ₹340,000 per **complete unit**, not per lot). `n_u=0` → skip. Basket-margin quote **not consulted** in this mode.
- **Quantity mode (Def 6.2)**: `n_u` = configured unit quantity; Gate 5.12's margin check applies (proxy described above).
- `q_{u,i} = n_u · u_i · L` (Eq 6.10) — **exact integer ratio at every size**, no fractional/volatility-scaled sizing, no per-week adjustment by signal strength. **Direction does not alter size.**

---

## 8. Entry execution protocol (PDF §8) — leg-by-leg, gated, atomic-order

**Placement order is fixed and non-negotiable**: `Buy ATM PE → Buy far PE → Sell middle PE` (1, 2, 3 exactly as declared). The generic "all purchases then all sales" re-sort used for simple spreads is **disabled** for this family — a specific long is sized against a specific short; a re-sort could release a short before its covering long.

### Marketable limit price (Definition 7.2)

```
b(p) = max(θ₁₂·p, θ₁₃)                    (buffer = max(8% of LTP, ₹3))
ℓ_B(p) = κ·⌈(p+b(p))/κ⌉                    (buy: round UP to tick)
ℓ_S(p) = max(κ, κ·⌊(p−b(p))/κ⌋)            (sell: round DOWN to tick, never ≤ 0)     (7.1)
```
`κ` = tick size, resolved per contract. Reference premium `p` is **re-read immediately before each leg is placed** (not the premium at call publication); if that re-read fails, fall back to the premium captured at call dispatch.

### Order acknowledgement with recovery (Definition 7.3)

Placement returns a broker order number, **or** a recovery verdict: on error / unparseable body / missing order-number field, search the subscriber's order book for a matching order (symbol, quantity, side, time ≥ attempt). Verdict ∈ {**PLACED** (order number recovered), **NOT-PLACED** (book readable, no match), **UNKNOWN** (book unreadable throughout the recovery window — **never assume it did not exist**)}. Expired session → switch to stored fresh token, then re-authenticate as last resort, **up to θ₂₁ (4) times**.

### Dual-source fill gate (Definition 7.4)

After leg `i` is acknowledged (order number ν), the next leg releases **only if leg i reaches COMPLETE**, confirmed by **either**:
(a) the platform ledger receiving the broker's fill/cancel/reject postback, or
(b) the broker order book, read at front-loaded offsets **θ₁₈ = {0.5, 1.2, 2.5, 5, 8}s**, then every **θ₁₉=12s**, not sooner than **θ₂₀=20s** after a failed read.

**Phase-aware deadline**:
```
deadline(t) = min(t_p+θ₁₇,  t_open+θ₁₆ if seen OPEN by t else t_p+θ₁₅)     (16.1)
```
i.e. `t_p+75s` while not yet OPEN at the exchange; `t_open+45s` once OPEN; hard cap `t_p+100s` in all cases.

```
outcome(ν) = FILLED   if COMPLETE seen in (a) or (b) before deadline
           = DEAD     if REJECTED/CANCELLED seen
           = TIMEOUT  otherwise                                            (7.2)
```

Gate applies to **every** leg including the last (non-final legs: margin gate — a resting protective order gives no margin benefit; final leg: rejection gate — an order number only proves acceptance). Between confirmed fill and next placement: pause **θ₁₄ = 750ms**.

### Per-subscriber entry state machine (n=3 legs)

`IDLE → SIZED → PLACING(i) → GATING(i) → COMPLETE → ROLLBACK → ABANDONED`

| From | To | Condition |
|---|---|---|
| IDLE | SIZED | passes Gate 5.2 (composite); `q_{u,i}` computed; all >0 |
| SIZED | PLACING(1) | fresh premium read; limit by (7.1) |
| PLACING(i) | GATING(i) | ack returns order number (direct or recovered) |
| PLACING(1) | **ABANDONED** | leg 1 verdict NOT-PLACED — nothing on the book |
| PLACING(i) | **ROLLBACK** | i>1 and NOT-PLACED, or **any** i with UNKNOWN |
| GATING(i) | PLACING(i+1) | outcome FILLED, i<n, after pause θ₁₄ |
| GATING(n) | COMPLETE | outcome FILLED for final leg |
| GATING(i) | **ROLLBACK** | outcome DEAD or TIMEOUT |
| ROLLBACK | ABANDONED | compensation finished; operator report emitted |

### Compensating rollback (Definition 7.5) — reverse placement order

Given placed legs `𝒫` and unconfirmed legs `𝒰`: process `𝒫` in **REVERSE placement order** (heavier shorts closed while their protective longs are still on):
1. Read status by order number, retrying for **θ₂₄=45s**.
2. If still working / unreadable: cancel blind, wait **θ₂₆=4s**, re-read for **θ₂₅=20s**.
3. Still unreadable → consult ledger postback status.
4. Still unresolved → consult broker **positions** endpoint (a different interface); size the compensation to the broker's net quantity in the entry direction, **never more than the leg itself put on**.
5. If filled: place the opposite-side limit priced by (7.1) and **fill-gate it before touching the next (lighter) leg**.
6. If any step can't establish state: **stop**, leave remaining lighter legs untouched, escalate.

Unconfirmed (UNKNOWN) legs are searched again in the order book by symbol/quantity/side after attempt time, unwound if found; if still indeterminate → escalated, **never assumed absent**.

**Invariant 7.6 (No naked short at entry)**: for every subscriber and instant during entry, filled short contracts are covered by filled longs placed earlier in declared order — except during the brief window of a compensating short-close in rollback, which is itself fill-gated before any long is touched.

**Post-entry audit**: at `t_f+θ₃₄` and `t_f+2θ₃₄`, reconciliation syncs order statuses/fills; second pass audits whether every subscriber who placed any leg holds a non-zero position on every declared leg. **Reports only — never auto-places a missing leg** (positions lag fills; auto-placement could double a leg).

**Proposition 7.7 (limit-price bounds)**: `ℓ_B(p) ≥ p+b(p)` and `< p+b(p)+κ`; `ℓ_S(p) ≤ max(κ, p−b(p))` and `> p−b(p)−κ` (when `p−b(p)≥κ`); both non-decreasing in p; `ℓ_S(p) ≥ κ > 0` always (never a non-positive sale).

---

## 9. In-trade management (PDF §9) — deliberately empty

**Zero stop-loss. Zero profit target. Zero trailing. No rolls. No re-centring. No delta hedge. No partial profit-taking.** The structure resolved on signal day is the structure held until exit, full stop. Do not invent any of these.

### Monitor-leg target ladder (Definition 8.1)

`F₀` = monitor future's LTP at call creation. Stored target = `F₀ + 300·D`.

```
F̂(t) = F₀ + D·(300 + 100·𝟙{weekday(t) ∈ {Monday, Tuesday}})              (8.1)
E_tgt = inf{t ∈ 𝕄 : D·(F_t − F̂(t)) ≥ 0}                                  (8.2)
```

So: **300 points** Wednesday through Friday, **400 points** Monday and Tuesday. Re-derived on **every futures tick** — never a scheduled job, and the stored `F₀` is **never mutated**. No stop-loss on the monitor leg either — an adverse move is simply held to the scheduled exit. Ticks outside `𝕄=[09:15,15:30]` cannot trigger the target.

### Chained exit (Definition 8.2)

On `E_tgt`, the monitor leg exits and — **concurrently** — the latest open call of Nifty Alpha Ladder (and, in the full PDF family, the other three sibling structures) is exited through the combined multi-leg exit interface, current price supplied for every leg. A **cross-process guard re-reads the monitor call's exit flag from the DB before acting**, so only one process performs the chained exit if several are watching the same price stream.

### Call-level lifecycle

`PUBLISHED → LIVE → EXIT_REQUESTED → EXITING → CLOSED → LEFTOVER_ALERT`

| From | To | Condition |
|---|---|---|
| PUBLISHED | LIVE | fan-out finished |
| LIVE | EXIT_REQUESTED | `E_tgt` (chained), OR Tuesday 15:10 scheduled, OR Tuesday 15:20 safety-net, OR explicit operator exit |
| EXIT_REQUESTED | EXITING | every leg priced (>0) and the multi-leg exit accepted |
| EXIT_REQUESTED | LIVE | a leg lacks a usable price, or exit request fails — retried next scheduled attempt |
| EXITING | CLOSED | per-subscriber short-first exits placed |
| CLOSED | LEFTOVER_ALERT | θ₃₅ after exit, a ledger primary has no exit order |

---

## 10. Exit protocol (PDF §10) — SHORT-FIRST, always

**Three triggers in time-precedence order**: (1) monitor target chained exit, (2) Tuesday 15:10 scheduled force-exit, (3) Tuesday 15:20 safety-net. Plus an explicit operator exit. **All converge on the same per-subscriber exit executor.**

### Definition 9.1 — Scheduled force-exit (Tuesday 15:10)

Every still-open call of the family (monitor + Nifty Alpha Ladder — clock-based exit does NOT run the chained-exit helper, so each is listed explicitly) is exited. For each call, a current LTP is obtained for **every leg** (primary gateway, broker fallback); a call with **any** leg lacking a positive price is **not submitted** this attempt. Up to **θ₃₂=5 attempts** at **θ₃₃=2min** intervals. "Settled" only when every algorithm is settled.

### Definition 9.2 — Safety-net exit (Tuesday 15:20)

Same family list swept again, duration-agnostic, own attempt budget; calls already exited are skipped. **Nothing runs after the safety net** — an unsettled outcome raises an **explicit operator alert**, never silently marked closed.

### Definition 9.3 — Per-subscriber exit sizing

Per leg, read open quantity remaining in the ledger (entry primaries less linked exits). Two guards **before placement**:
1. **Over-exit guard**: if ledger's signed net is already on the exit side, **don't place** (would open a reverse position). For a gated leg, protective legs behind it proceed only if the broker confirms the contract is not open on the entry side.
2. **Broker-truth clamp**: for non-postback brokers, clamp quantity to broker's current net in the entry direction (0 if flat) — positions read shared across a subscriber's legs for **θ₃₈=10s**.

### Definition 9.4 — Exit sequencing (the critical rule)

**All SHORT-entered legs close first**, each gated to COMPLETE within **θ₂₇=60s** (ledger postback or order book). **Only after every short is confirmed closed** are LONG-entered legs sold, **without gating**.

```
σ_exit = ({i : s_i=S} in declared order) ⊕ ({i : s_i=B} in declared order)   (9.1)
```

If a short fails to close: **stop for that subscriber, leave protective longs OPEN on purpose** — a covered residual is safe, a naked short is not.

Before any exit order: cancel working orders of the algorithm on each contract. If the ledger read for **any** leg fails after **θ₂₈=5** attempts (linear back-off): **no leg exited for anyone** (a partial read would exit legs unsequenced); reconciliation scheduled, operator alerted.

**Blindness guard**: if a subscriber's short-leg rows are missing while long-leg rows are present — before selling that subscriber's protective legs, read broker positions; if any declared short contract is still open, **skip and report that subscriber**.

### Definition 9.5 — Exit pricing and chase (repricing schedule)

Initial exit price by (7.1). Then wait a random delay from **θ₂₉=[10,20]s uniform**; thereafter, until terminal, re-read premium and, whenever the new limit differs from working limit by ≥ half a tick, modify to:

```
ℓ^(i) = ℓ_S(p_i; b = max(Φ̃(i)·p_i, θ₁₃))
Φ̃(i) = max(Φₓ(i), 𝟙{t≥15:20}·Φ_ℓ(i))                                        (9.2)
```

`Φₓ(i)` (θ₃₀) = **2.5%** for i<5, **5%** for 5≤i<12, **10%** for i≥12.
`Φ_ℓ(i)` (θ₃₁, floor after 15:20) = **18%** for i<5, **24%** for 5≤i<12, **30%** for i≥12.

Futures use a **separate, tighter** schedule — **not specified numerically in the PDF body for this family** (Nifty Alpha Ladder has no futures leg of its own — the monitor leg's exit schedule is a different algorithm's concern, out of scope here; **see Ambiguity A3**).

**Invariant 9.6 (exit monotonicity)**: ledger net moves monotonically toward zero, never crosses zero — no exit placed on a contract already on the exit side; non-postback brokers never exceed broker net.

**Invariant 9.7 (hedge-last)**: no long leg sold while any short leg of the same structure is open for that subscriber at the broker, except when the short-leg state is unreadable (nothing was placed).

**Leftover reconciliation**: at `τ_x+θ₃₄` and `τ_x+2θ₃₄`, re-sync statuses/fills and audit leftovers (shorts before longs, serialised so two passes can't both sell the same hedge). Independently, **θ₃₅=12min** after each call's exit time, a ledger check (look-back **θ₃₆=90min**, up to **θ₃₇=3** attempts) lists every primary with no linked exit — **alert only, never places orders**. Daily 15:15 positions reconciliation across all algorithms, per-algorithm attribution. Repair is an **explicit operator action**.

**Calendar edge**: scheduled/safety exits keyed to calendar Tuesday, skipped on non-trading day. If the weekly expiry is advanced by a holiday, an open structure reaches exchange settlement at that expiry unless the monitor target already closed it.

---

## 11. Failure modes and reconciliation (PDF §11) — full table

| Failure | Detection | Response | Invariant preserved |
|---|---|---|---|
| Signal data missing (empty large-order/imbalance series) | Gate 5.5 | no signal this minute; re-eval each lattice minute to 14:31 | no position |
| Large-order path has zero area | d₁=0 | no decision recorded; re-eval next minute | no position |
| India VIX unreadable at τ* | χ=0 | Variation C inert; D₀ traded | causality of D |
| Strike not listed / resolution error | null leg | structure not published; siblings/monitor unaffected | no partial structure |
| Signal fired but structure resolution failed | operator observation | manual re-creation for the direction the monitor already took; **Γ not re-evaluated** | family direction consistency |
| First leg rejected/not placed | verdict NOT-PLACED at i=1 | subscriber abandoned; nothing on book | no position |
| Later leg not placed or UNKNOWN | verdict at i>1 | rollback of placed legs; unconfirmed leg searched + unwound if found | 7.6 |
| Leg accepted then rejected by risk checks | gate outcome DEAD | rollback incl. rejected leg's re-check | 7.6 |
| Leg resting unfilled (price moved away) | gate outcome TIMEOUT | cancel-first rollback; unwind filled legs in reverse | 7.6 |
| Order book rate-limited/unreadable during gate | failed reads | ledger postback accepted as fill evidence; sparse back-off reads | no false TIMEOUT |
| Session invalidated mid-entry | session-expired response | stored fresh token, then re-auth, up to θ₂₁; gate/rollback continue on live token | state established before action |
| Rollback cannot establish a leg's state | book/ledger/positions all inconclusive | stop; lighter legs left; operator report | no over-close into reverse position |
| Exit ledger read failure | θ₂₈ failed attempts | no leg exited for anyone; reconcilers scheduled; alert | 9.7 |
| Short leg does not close within θ₂₇ | exit gate | protective longs left open for that subscriber; reconciler follow-up | 9.7 |
| Ledger over-exited | signed net on exit side | leg skipped; hedge released only if broker confirms flat | 9.6 |
| User closed a leg manually (non-postback broker) | broker-truth clamp | exit clamped to broker net (0 if flat) | 9.6 |
| Leg lacks a live price at scheduled exit | price ≤ 0 | call not submitted this attempt; retried; safety net at 15:20 | no mispriced exit |
| Process loss during an exit | leftover check after θ₃₅ | alert listing unexited primaries; operator repair | detection within minutes |
| Duplicate trigger from several processes | DB exit flag re-read | only the first process exits | single exit |

**Invariant 10.1 (record completeness)**: every order placed/recovered — including rollbacks and their compensating exits — is represented in the ledger, terminal status synced from broker. **Positions and P&L derive only from COMPLETE rows.**

**Invariant 10.2 (idempotency)**: at most one signal/week (key κ(d)); at most one call/algo/calendar-day; at most one chained exit/monitor-exit event; exits skip already-exited calls.

**What the system deliberately does NOT do**: auto-top-up an incomplete structure; retry a failed entry leg at a worse price; substitute a different strike when a leg is unavailable; re-evaluate direction after publication.

**Definition 10.3 (rollback residue guard)**: `𝒩` = contracts for which rollback placed no compensating order. After unwind, broker's account-level net for every `k∈𝒩` is read with patience; **any non-zero net is escalated for manual verification** — the guard **never auto-places an order** (an account-level net could stem from an unrelated position in the same contract).

---

## 12. Risk characterisation (PDF §12)

For one unit, bearish orientation (bullish = mirror):

```
Δ_net = L·(4Δ_A + Δ_{A−400} − 5Δ_{A−200})
Γ_net = L·(4Γ_A + Γ_{A−400} − 5Γ_{A−200})
ν_net = L·(4ν_A + ν_{A−400} − 5ν_{A−200})                                  (11.3)
```

- **Directional**: at entry the four ATM longs dominate → delta sign of D; magnitude decreases toward zero as index moves through A−200 to below A−400.
- **Convexity/vol**: long gamma/vega near A at entry; as index approaches A−200 the five shorts dominate → **short gamma, short vega**. Sign of ν_net at entry depends on the vol surface/time-to-expiry.
- **Bounded loss**: expiry value non-negative → max loss/unit = δ (the debit), reached when index finishes unfavourable of A.
- **Profit geometry**: peak 800 pts/unit at A−200, floor 600 pts below A−400. No unbounded tail either side.
- **Leg count**: 10 contracts/unit across 3 strikes — larger execution/settlement footprint than a vertical spread.

**Family-level risks** (apply even though we build only one of the four siblings): signal concentration (one weekly decision drives everything — a wrong direction affects the whole week); trigger-underlying basis risk (exit defined on the future, options settle on the index — basis shifts move where the chained exit lands in the payoff); holding-period gap risk (weekend/overnight, no intermediate stop); implied-vol regime risk (VIX near θ₇ can flip direction on small print differences); protective-strike liquidity (farthest strikes least liquid — θ₁₃ absolute floor exists exactly for this); execution-under-load (rate limits/delayed routing lengthen gates, trigger rollbacks for a subset); margin (carry-forward product needs exchange margin for shorts throughout the hold).

```
L_max(u) = n_u·L·δ    (expiry-value bound; also bounds pre-expiry mark-to-market, ex. execution costs)   (11.5)
```

---

## 13. Operating calendar and timing lattice (PDF §13) — full reference table

| When | Process | Effect |
|---|---|---|
| Wed 09:31–14:31, every minute | Signal evaluation | First fire publishes monitor + structure |
| Thu 09:31–14:31, every minute | Signal evaluation — **only if Wednesday was not a trading session** | Holiday fallback |
| Signal instant τ* (≤14:30) | Direction D fixed; VIX read at τ*; call published; fan-out | Entry |
| τ*+θ₃₄, τ*+2θ₃₄ | Entry reconciliation + completeness audit | Report only |
| Every futures tick, 09:15–15:30, Wed–Fri | Monitor target F₀±300 | Chained exit on hit |
| Every futures tick, 09:15–15:30, Mon–Tue | Monitor target F₀±400 | Chained exit on hit |
| Daily 15:15 | Cross-algorithm positions reconciliation | Report only |
| Tuesday 15:10 | Scheduled force-exit, up to θ₃₂ attempts @ θ₃₃ | Exit |
| Tuesday 15:20 | Safety-net force-exit | Exit of anything still open |
| After 15:20 | Exit re-pricing floor Φ_ℓ applies | Faster completion |
| Exit+θ₃₄, +2θ₃₄ | Exit reconciliation + leftover audit | Report / sequenced repair |
| Exit+θ₃₅ | Ledger leftover check | Alert only |

**Weekly timing lattice (standard week, Tuesday weekly expiry)**:

| Day | Entry | Monitor target | Scheduled exit |
|---|---|---|---|
| Wednesday | signal window 09:31–14:30 | 300 pts (after entry) | — |
| Thursday (holiday-fallback weeks only) | 300 pts | — |
| Friday | — | 300 pts | — |
| Monday | — | 400 pts | — |
| Tuesday (expiry day) | — | 400 pts | 15:10 force-exit; 15:20 safety net |

Holding period: **at most 6 calendar days** (5 on a Thursday-fallback week), **at most 4 trading sessions** after entry, ends before close of the traded series' own expiry day under normal calendars.

---

## 14. State machines — consolidated (PDF §7/§9/§16)

### SIGNAL
`WAITING → READY → FIRED / INVALID / ERROR` (your requested naming — the PDF's own equivalent concepts are Gates 5.4–5.6 plus the persisted signal record; PDF doesn't name these states explicitly, this is our own state naming layered onto its idempotency/resolvability gates)

### ENTRY (per-subscriber basket, PDF's actual names, §8)
`IDLE → SIZED → PLACING(i) → GATING(i) → COMPLETE → ROLLBACK → ABANDONED`

### ENTRY LEG (PDF §17, Definition 16.1 — the granular per-order states)
`NEW → SUBMITTING → ACK_OK/ACK_NOT_PLACED/ACK_UNKNOWN → WITH_BROKER → OPEN_AT_EXCHANGE → COMPLETE/DEAD/TIMEOUT`

### ROLLBACK (per placed leg, reverse order, PDF §17)
`LOOKUP → CANCEL → RECHECK → LEDGER_CHECK → POSITIONS_CHECK → UNWIND_PLACE → UNWIND_GATE → UNWOUND / NOTHING_TO_UNWIND / UNKNOWN_STOP`

### CALL (structure-level, PDF §9)
`PUBLISHED → LIVE → EXIT_REQUESTED → EXITING → CLOSED → LEFTOVER_ALERT`

### EXIT LEG (per-subscriber, PDF §17)
`QUEUED → CANCEL_WORKING → SIZED → SKIP_OVEREXIT/SKIP_FLAT/PLACED → RESTING → GATED_COMPLETE/COMPLETE`, and `QUEUED → HELD_OPEN` (long leg only, when a short's gate failed)

### Reconciliation predicates (PDF §17, Definition 16.x) — enforced-by-construction vs audited

**Enforced by construction** (executor cannot violate without an external actor, e.g. a manual broker trade): `I₁` declared-order prefix, `I₂` exact ratio at completion, `I₃` reverse-order unwind, `I₄` hedge-last exit, `I₅` no sign flip, `I₆` quantity conservation.

**Audited, not enforced** (violation → operator report, repair is a manual action): `R` broker–ledger agreement (checked at `t_f+θ₃₄`, `t_f+2θ₃₄`, daily 15:15, `τ_x+θ₃₄`, `τ_x+2θ₃₄`); `L` no unexited primary (checked at `τ_x+θ₃₅`, look-back θ₃₆, up to θ₃₇ attempts).

---

## 15. Worked numerical example (PDF §19) — reference for test fixtures

This entire worked example (lot size L=75 assumed for arithmetic) should become the **first deterministic replay test fixture**, since it exercises the full pipeline end-to-end with known correct outputs at every stage:

- **G₂ path**: 19 snapshots from 09:18 to 10:12 (3-min cadence), crossing at **10:12 with G₂=−9.13** → `t_f=10:13`, `τ*=τ_×=10:12`, crossing path, `d₂=sgn(−9.13)=−1`, `g*=−9.13`.
- **G₁ knots**: 7 knots 09:16→10:15; trapezoidal area to τ*=10:12 interpolates the partial final segment: `G̃₁(10:12) = 2880 + 820·(6/9) ≈ 3426.67`; `𝒜₁(10:12) ≈ 7,707,000` contract-seconds → `d₁=+1`.
- **Alignment**: d₁=+1, d₂=−1 → divergent, α=0, D₀=d₁=+1 (bullish).
- **Variation C**: VIX bars 12.31/12.08/11.94/11.87 at 09:15/09:30/09:45/10:00; latest at/before τ*=10:12 is the 10:00 bar → v*=11.87, χ=1. W=true (α=0, strength clause irrelevant per Prop 4.3 since 9.0≥4.5). v*=11.87<12.5 → **reversed**: D=−1 (bearish).
- **Monitor**: F₀=24,211.80, SELL 1 lot, target 23,911.80 (Wed–Fri), 23,811.80 (Mon–Tue).
- **Strike/expiry**: S=24,137.40 at resolution, Δ=50, A=24,150 (dist 12.60 < 37.40 to next strike down); nearest listed expiry 6 days out → e*=that Tuesday.
- **Legs (unmirrored, D=−1)**: Buy 4×PE@24,150, Buy 1×PE@23,750, Sell 5×PE@23,950.
- **Sizing**: unit budget ₹340,000, allocation ₹700,000 → `n_u=⌊700000/340000⌋=2`.
- **Fills**: leg1 buffer=max(0.08×111.20, 3)=8.90→limit 120.10→fill 111.35; leg2 buffer=3.00→limit 20.30→fill 17.45; leg3 buffer=3.81→limit 43.75→fill 47.45. Net debit δ=225.60 pts/unit. Max loss=₹33,840; max gain=₹86,160 at S_T=23,950; tail=₹56,160; break-even=24,093.60.
- **Fill-gate timing example**: leg1 placed at t_p; reads at t_p+0.5s (WITH_BROKER), t_p+1.2s (COMPLETE, confirmed by postback too); deadline had been t_p+75s, would've become t_open+45s if seen resting, capped at t_p+100s. Pause 750ms, release leg2, etc.
- **Exit (target hit Friday 13:41 at F=23,910.50, basis≈75.50, S≈23,835)**: shorts-first, gated ≤60s each; then longs sold. Closing proceeds/unit=637.95; realised P&L/unit=637.95−225.60=412.35 pts → ₹61,852.50/subscriber (2 units × 75 lot × 412.35... actually PDF states ×150 directly, i.e. n_u·L=2×75=150).
- **Adverse counterfactual**: index closes 24,420 at Tuesday 15:10 force-exit → V⁻(24,420)=0 → P&L=−225.60 pts/unit = −₹33,840 (exactly the structural bound).

---

## 16. Broker/market-data dependencies (what thetalab needs to actually provide)

| Requirement | PDF need | thetalab today |
|---|---|---|
| NIFTY spot LTP | tick/LTP | Kite quote — have |
| Nearest NIFTY future tick stream | continuous tick | Kite — **needs a streaming subscription (WebSocket), not REST polling**; see Ambiguity A4 |
| India VIX, 15-min bars | historical + live bar | Kite historical-candle API for the VIX instrument — should exist, unconfirmed for this exact granularity in production use so far |
| NIFTY bid/ask depth ladder (price, qty, order count) **continuously, event-driven** | 5-level depth, order-count field, change-detected per level | Kite `KiteTicker` WebSocket `mode=full` carries 5-level depth with quantity **and orders count**; REST `/quote` only gives a point-in-time snapshot — **not sufficient** for this feature's event semantics. See Ambiguity A4 |
| NIFTY weekly option chain / listed contracts | full chain per expiry | Kite instruments master — have, already used by Options Auto-Trader |
| Option LTP on demand | quote | Kite — have |
| Broker order/position data | order book, position book, postbacks | Kite/Groww functions already exist (adapted this session for Options Auto-Trader); **reusable per your rule 57 only if semantics match** — needs its own review, not assumed |
| Basket-margin quote | Groww/Kite basket margin | `fetchGrowwBasketMargin` / Kite basket-margin exist; reusable candidate, not yet verified against this structure's specific 3-leg proxy rule |

---

## 17. PDF section → proposed code module mapping

| PDF section(s) | Concept | Proposed module (per your suggested tree) |
|---|---|---|
| §3 Def 2.1, §13 | Clock lattice, calendar gates 5.1/5.2/5.3 | `calendar/signalCalendar.ts` |
| §4 Def 3.1 | Expiry selection | `calendar/expirySelection.ts`, `instruments/expiryResolver.ts` |
| §3 Def 2.2, §13 Def 13.3 | Large-order threshold + event detection | `data/depthCollector.ts`, `signal/largeOrderNet.ts` |
| §3 Def 2.6 | Aggregate snapshot (B_k, A_k, ρ_k) | `data/aggregateImbalance.ts`, `signal/imbalancePath.ts` |
| §5 Eq 4.1–4.2, 4.3–4.4 | G₁/G₂ paths + signed areas | `signal/largeOrderNet.ts`, `signal/imbalancePath.ts`, `signal/signedArea.ts` |
| §5 Eq 4.5–4.9 | Signal instant, component directions, alignment Ψ | `signal/signalEngine.ts`, `signal/alignmentRule.ts` |
| §5 Eq 4.10–4.11 | Variation C | `signal/variationC.ts` |
| §3 Def 3.1–3.5 | Strike step, ATM, leg template, mirror, resolution | `instruments/strikeResolver.ts`, `instruments/expiryResolver.ts`, `instruments/ladderTemplate.ts` |
| §6 Gates 5.7–5.12 | Structure/subscriber eligibility | `sizing/capitalGate.ts` + calendar/signal gates above |
| §6 Def 6.1–6.2, Eq 6.10 | Sizing (unit/quantity mode) | `sizing/unitSizing.ts`, `sizing/quantitySizing.ts` |
| §6 Eq 6.6–6.7, 6.11 | Payoff / risk math | new `risk/payoff.ts` (not in your original tree — needed) |
| §7 Def 7.1–7.5 | Marketable limit, fill gate, rollback | `execution/marketableLimit.ts`, `execution/entryExecutor.ts`, `execution/fillGate.ts`, `execution/rollback.ts` |
| §7 post-entry audit | Reconciliation | `execution/reconciliation.ts` |
| §9 Def 8.1–8.2 | Monitor leg, target ladder, chained exit | `monitor/futuresMonitor.ts`, `monitor/targetEngine.ts` |
| §10 Def 9.1–9.5 | Scheduled exit, safety net, sequencing, repricing | `exit/scheduledExit.ts`, `exit/safetyExit.ts`, `exit/shortFirstExit.ts`, `exit/repricing.ts`, `exit/exitEngine.ts` |
| §10 leftover check | Leftover verification | `exit/leftoverCheck.ts` |
| §11 | Failure modes (woven through, not a separate module) | reflected in `execution/*`, `exit/*`, `monitor/*` error paths |
| §16 Ledger objects, predicates | Persistence, invariants | `persistence/*` |
| §17 Leg lifecycle | Order state machines | `persistence/orderRepository.ts`, `persistence/stateRepository.ts` |
| §19 Worked example | Test fixtures | `__tests__/`, `research/replay.ts` |
| §1 Appendix A | Parameter register | `parameters.ts` |

---

## 18. Ambiguities and unresolved requirements — MUST be resolved before implementation

These are documented per your explicit instruction (§53 item 12) rather than silently decided.

### A1 — What real, tradable instrument is "the NIFTY book" (ℒ_t^b, ℒ_t^a)?

The PDF's primitive-process table (§3) defines depth ladders "on the bid and ask sides of the NIFTY book," and §5 refers to a "primary (spot) imbalance document for the day," falling back to "the futures-book imbalance document for NIFTY." **NIFTY 50 the index has no order book of its own** — it is a computed value, not a tradable instrument. Two readings are possible:
1. The vendor's own internal "spot order-flow" feed is actually derived from the **nearest NIFTY future's own depth**, and the described "futures fallback" is really a *different, more distant* futures contract's depth (e.g. current-month vs next-month) — in which case both "spot" and "futures" documents are genuinely two different futures contracts, not spot-vs-future.
2. The vendor purchases a separate NSE/exchange **spot order-flow proxy** product not available through a standard retail Kite Connect / Groww API subscription — in which case this strategy **cannot be built on Kite/Groww retail market data at all**, and needs a different data vendor.

**This must be resolved with you before any depth-collection code is written** — it determines whether the feature is buildable on existing infrastructure at all.

### A2 — Multi-subscriber platform vs thetalab's single account

The PDF is written for a multi-tenant SaaS platform: "subscriber," "fan-out," "capital allocated," "broker session token returned for them at fan-out," per-subscriber gates 5.8–5.12, same-day trade caps, opposite-position conflict checks across "algorithms." thetalab is a **single account, single settings row** (as established throughout this session for Options Auto-Trader — one `kite_session`, one `groww_session`, one settings row `id=1`).

**Proposed resolution** (not yet implemented, needs your confirmation): collapse "subscriber" to **the single configured account** — `n_u` computed once from that account's own allocated capital/settings, Gates 5.8–5.11 (cross-algorithm conflict, same-day cap, session check) simplified to "does Nifty Alpha Ladder's own single position already exist" rather than a fan-out loop. This materially simplifies §6 and the entry/exit executors but is a real architectural deviation from the PDF's literal design, done because the PDF's multi-tenant scaffolding has no counterpart to preserve faithfully.

### A3 — Futures exit repricing schedule for the monitor leg

§9/Definition 9.5 states "Futures use a separate, tighter schedule" for exit repricing but the PDF body does not give that schedule's numeric values anywhere I can find in the 45 pages (Appendix A defines θ₃₀/θ₃₁ only for **option** exits). Either the futures schedule is genuinely unspecified in this document (an omission on the source side), or it belongs to a sibling document about the monitor leg's own algorithm that this PDF assumes exists but doesn't reproduce. **Needs clarification**: what governs the monitor future's own exit chase, if we are building the monitor leg ourselves?

### A4 — Depth-feed architecture vs serverless functions

The large-order/imbalance features require **continuous, event-driven depth observation** (Definition 2.2's "new at price / quantity changed / order count changed" change-detection, and Definition 2.6's "admitted each time the price is first seen or the pair differs") — this needs a **persistent WebSocket connection** (Kite's `KiteTicker`, mode `full`), not periodic REST polling. thetalab's `api/options-autotrade.ts` runs as **stateless Vercel serverless functions**, invoked by an external 1-minute cron pinger (established multiple times this session) — there is currently **no long-running process anywhere in thetalab** to hold a WebSocket open and accumulate depth events between invocations.

**This is the single largest infrastructure gap.** Building this faithfully likely requires either: (a) a new, separate always-on process (a small Node service on Railway/Fly/a VPS, as I flagged as an option in an earlier conversation this session about sub-minute polling) that maintains the WebSocket and writes merged large-order events / aggregate snapshots to Supabase for the serverless signal-evaluation function to read, or (b) accepting a materially degraded approximation via frequent REST polling (which cannot faithfully implement Definition 2.2/2.6's per-level change detection). **This needs your decision before §54 (core engine) can be built**, since it changes the shape of `data/depthCollector.ts` entirely.

### A5 — Gate 5.8 (cross-algorithm conflict) scope

Given only one of the four sibling structures is being built, and Options Auto-Trader is a completely unrelated, isolated system per your explicit instruction — does Gate 5.8's "another algorithm's OPEN calls" ever need to consider Options Auto-Trader's positions? My reading of your instructions is **no** (strict isolation), making this gate effectively vacuous until/unless sibling hedged133-family structures are ever built. Flagging so this isn't silently assumed.

### A6 — Broker selection for Nifty Alpha Ladder

The PDF is broker-agnostic. thetalab currently has one dual-broker execution layer (Kite/Groww) scoped to Options Auto-Trader's own settings row. Does Nifty Alpha Ladder get its **own independent** `active_broker`/`execution_mode` setting (own settings row), reusing the same underlying Kite/Groww session tokens, or does it share Options Auto-Trader's setting? **Proposed**: its own independent settings row, given your "completely separate module" instruction — needs confirmation.

### A7 — India VIX bar source confirmation

Section 3 and Appendix A (θ₉=15min) assume a reliable 15-minute India VIX bar series is available at signal time. Kite provides India VIX as a quotable index and has a historical-candle endpoint; whether Kite's historical API actually serves this index at 15-minute granularity in practice (vs only daily) is **unconfirmed** — needs a real API check before implementation, not assumed.

---

## 19. What this document does NOT yet cover

Per your milestone gating (§53), this document stops at specification reconstruction. It does not yet contain:
- Concrete TypeScript interfaces/types.
- Database schema / migrations.
- Any executable code.

Those belong to the Implementation Plan (companion document) and to Milestone 2 (§54), which does not start until this spec is approved and Ambiguities A1 and A4 in particular are resolved — they change the shape of the core engine.
