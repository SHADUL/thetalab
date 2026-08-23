# NIFTY Strategy Simulator

Build an options position on any past expiry, step forward one session at a time, and watch
the payoff, Greeks and P&L move with it.

Vite + React + Tailwind v4 + Framer Motion + Recharts. Entirely client-side — no server, no
API keys, nothing leaves the browser.

---

## Run it locally

```bash
npm install
npm run dev
```

Open the URL it prints (usually http://localhost:5173).

## Put your data in

Copy the bundle from the downloader into `public/`:

```bash
cp ../nifty-option-backtester/chain_bundle.json public/
```

The app loads `/chain_bundle.json` automatically on startup, so once it's in `public/` the
file picker never appears — the site opens straight into your real data, and the bundle
deploys with the site. Without it, you get the file picker and a sample-data option.

Bundles above ~40 MB make the first load slow. Trim with:

```bash
python -m optdata.cli bundle --spot nifty50_daily_combined.csv \
  --out chain_bundle.json --lookback 8 --window 5
```

---

## Deploy to Vercel

**One-time setup**

```bash
git init
git add -A
git commit -m "NIFTY strategy simulator"
```

Create an empty repo on github.com (no README, no .gitignore), then:

```bash
git remote add origin https://github.com/<you>/nifty-sim.git
git branch -M main
git push -u origin main
```

Go to vercel.com, sign in with GitHub, **Add New → Project**, pick the repo. Vercel detects
Vite on its own — framework preset Vite, build `npm run build`, output `dist`. Press Deploy.
You get a live URL in about a minute.

**Every deploy after that**

```bash
git add -A
git commit -m "what changed"
git push
```

Vercel rebuilds automatically on push.

### If the bundle is too big for git

GitHub rejects files over 100 MB and warns above 50 MB. If yours is large, either trim it with
the `--lookback` / `--window` flags above, or keep it out of the repo and load it through the
file picker instead:

```bash
echo "public/chain_bundle.json" >> .gitignore
```

---

## Strategy wizard

Set a view — NIFTY stays between two levels, goes above one, or below one — pick a target date,
and it prices every relevant structure off that session's chain: short straddles and strangles,
iron condors, iron flies, butterflies, credit and debit spreads, outright calls and puts.

**Profit if right** is the *worst* outcome anywhere inside your predicted range, not the best.
A structure ranked highly therefore pays at least that much anywhere your view holds, which is a
stricter test than quoting profit at a single price. Max loss is measured across the charted
range; a naked short leg can lose more beyond it. Capital is defined risk for hedged structures
and a rough 12% margin proxy for naked ones — not SPAN.

Every leg's implied volatility is solved from its own traded premium, so a target date before
expiry is valued at the remaining tenor rather than at intrinsic. **Load** drops the whole
structure into the simulator so you can step it forward day by day.

## Using it

- **Chain** — hover a premium (tap on mobile) and pick **B** or **S**. The strike stays badged
  with your net lots and average entry price, and appears as a marked line on the payoff chart.
- **Lots** — the box in the Positions header sets lots for the *next* leg. Each existing row has
  its own − / + stepper, so legs can have different sizes.
- **Day stepper** — move one session at a time, or jump to expiry. Everything reprices.
- **Exit** closes a leg at the current day's price and keeps the realised P&L in the totals.
  **✕** removes it entirely.
- Legs are saved in the browser per expiry, so a refresh doesn't lose your position.

## What the numbers are and are not

Implied volatility is solved from each observed premium, so the Greeks and the dashed "today"
curve come from real traded prices. That curve holds each leg's IV constant as spot moves —
real IV rises when the market falls, so on the downside it reads optimistic.

Probability of profit is a lognormal estimate from ATM IV. It is a model output, not a
historical frequency, and it will disagree with empirical numbers from the weekly expiry study.

Approximate margin is 12% of short notional less 6% of long cover. That is **not SPAN** — real
margin needs NSE's risk parameter files. Don't size real trades from it.

P&L excludes brokerage, STT and slippage. Lot size follows NSE's history (75 before Jan 2026,
65 after); add a row to `LOTS` in `src/lib/options.js` when it changes again.
