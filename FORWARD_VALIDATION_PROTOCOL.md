# FORWARD_VALIDATION_PROTOCOL.md

**Written and committed before any SHADOW forward data has been collected.** This is the rule set
the eventual `FORWARD_VALIDATION_REPORT.md` will be held to — it is not adjusted after seeing
results, and no result from this protocol may be used to justify changing the protocol itself
mid-sample.

## Frozen for the duration of this forward sample

- **BASELINE_V1 parameters stay frozen** — skew threshold, delta targets, wing widths, DTE limits,
  quality thresholds, profit target, stop loss, time exit, risk percentages, margin utilization.
  Any change to any of these starts a NEW forward sample under a new baseline name; it does not
  extend this one.
- **No retroactive deletion of bad trades.** Every SHADOW signal recorded in the forward-validation
  ledger stays in the ledger permanently, whether it turns out to be a loser, a data-quality
  problem, or an embarrassing mistake. A genuinely bad DATA row (e.g. a confirmed ingestion bug)
  may be flagged as such, but is never deleted — see the ledger's own append-only design (§7 of the
  live-data-capture phase).
- **No changing exit rules mid-sample.**
- **No changing execution assumptions mid-sample** — `SHADOW_EXECUTION_V1` (or whichever fill model
  is live-labeled as governing this sample) stays the same model for every trade in the sample.
- **No changing which resource/cron cadence drives SHADOW scanning mid-sample**, since that would
  change the effective trade frequency being measured.

## Minimum forward evidence target

**Both** of the following must hold before any "forward validation" conclusion is drawn — whichever
takes longer:

- **At least 30 completed NIFTY SHADOW trades** (a trade is "completed" when its exit is recorded
  in the forward-validation ledger — win, loss, or a defined exit reason; a still-open position
  does not count).
- **At least 3 calendar months elapsed** from the first SHADOW signal recorded.

Forward validation must **not** be declared before both conditions hold. If only one holds (e.g. 3
months elapsed but only 12 trades completed, or 30 trades completed in 6 weeks), the correct
reportable status is **"minimum not yet met,"** not a partial or preliminary verdict.

## What "SHADOW" means for this protocol specifically

SHADOW runs the exact live decision pipeline (quotes → enrichment → skew → expiry selection →
candidate selection → quality score → decision gate → position sizing → pre-trade validation → risk
limits) and records the complete hypothetical order intent, but sends **zero** broker orders.
Execution is simulated from the **real, live bid/ask** captured at decision time (`SHADOW_EXECUTION_V1`),
not the historical backtest's assumed-spread model (`REALISTIC_V1`) — this is what makes SHADOW data
usable to eventually calibrate/replace that assumption, per the live-data-capture phase's own stated
purpose.

## Symbols in scope

NIFTY is the only symbol with historical out-of-sample validation already completed
(`OUT_OF_SAMPLE_VALIDATION_REPORT.md`). BANKNIFTY and SENSEX forward SHADOW data is collected under
this same protocol from day one, but is explicitly `FORWARD_DATA_ONLY` — no historical comparison
exists for either, and no NIFTY finding may be extrapolated to them.

## Governing question

Once the minimum evidence target is met, `FORWARD_VALIDATION_REPORT.md` will answer exactly one
question, using forward SHADOW data only: **"Does the historical NIFTY edge persist in genuinely
unseen forward data?"** — YES / NO / INSUFFICIENT DATA, not forced, exactly as
`VALIDATION_CRITERIA.md` established for the historical out-of-sample phase.
