# VALIDATION_CRITERIA.md

**Written and committed BEFORE the walk-forward test was run.** These are the criteria the final
`OUT_OF_SAMPLE_VALIDATION_REPORT.md` will be judged against — they are not adjusted after seeing
results.

## Criteria for a "robust positive out-of-sample net expectancy" (YES) verdict

All of the following must hold on **TEST-window-only** trades (never TRAIN/VALIDATE), under
**REALISTIC** execution assumptions, for **BASELINE_V1** (no parameter changed from production):

1. **Positive aggregate TEST-only net expectancy per trade.**
2. **Profit factor > 1.0** on aggregate TEST-only trades.
3. **Edge does not depend entirely on one year or one walk-forward window** — operationalized as:
   fewer than 100% of the positive aggregate result coming from a single calendar year, AND at
   least half of individual TEST windows individually net-expectancy-positive (a strategy that is
   only ever profitable in one out of many windows is not "robust" even if the sum is positive).
4. **REALISTIC remains net-expectancy-positive** (criterion 1, restated for clarity since REALISTIC
   is the governing assumption set for this verdict, not IDEAL).
5. **STRESS behavior is documented**, not required to be positive — a negative or lock-triggering
   STRESS result does not by itself force a NO verdict, but must be reported plainly (this phase
   already found STRESS remains positive at the whole-sample level in the prior, non-walk-forward
   pass; this criterion asks whether that holds specifically in TEST windows too).
6. **Minimum sample size**: at least 20 real TEST-window trades in aggregate. Below this, the
   verdict is **INSUFFICIENT DATA** regardless of the sign of any of the above, since a positive OR
   negative result from fewer than 20 trades is not statistically distinguishable from noise given
   this strategy's own historical win rate (~85%) and trade frequency.

## Automatic INSUFFICIENT DATA conditions (checked first, before 1-6 above)

- Fewer than 20 aggregate TEST trades (criterion 6).
- Fewer than 2 complete walk-forward TEST windows (a single window cannot demonstrate "does not
  depend on one window").
- No real historical data available for the symbol in question (applies to BANKNIFTY/SENSEX by
  default, per the prior phase's own finding — carried forward, not re-litigated here).

## Explicit non-criteria (things that do NOT determine the verdict)

- IDEAL-mode results are never used for the verdict — theoretical ceiling only.
- A positive Monte Carlo median does not by itself satisfy any criterion above — Monte Carlo in
  this phase is a risk-distribution tool only, per the task's own instruction, not evidence of edge.
- Portfolio-sized (vs. 1-lot) capital-curve results do not affect the verdict — sizing can make a
  weak per-trade edge look large in absolute rupees; the verdict is about per-trade expectancy.
- A well-performing individual strategy type (e.g. Iron Condor alone) passing while another
  (e.g. Bear Call Spread) fails does not by itself flip the aggregate verdict either way — both are
  reported per §5 of the final report, but the verdict question is about BASELINE_V1 as a whole,
  since disabling any one structure is explicitly out of scope for this phase.

## Methodology commitment

Walk-forward windows: TRAIN 12 months → VALIDATE 3 months → TEST 3 months, rolled forward across
the full available real NIFTY history (2024-02-01 to 2026-09-15). Window lengths are **not**
selected after previewing results — they are the task's own stated example, used as given. If the
resulting window count is too small to produce a meaningful TEST-only sample (see INSUFFICIENT DATA
conditions above), that is itself a reportable finding, not a reason to silently pick different
window lengths after the fact.
