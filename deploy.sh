#!/usr/bin/env bash
# One-shot deploy helper. Safe to run repeatedly — it commits and redeploys.
set -e
cd "$(dirname "$0")"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
warn() { printf "\033[33m  ! %s\033[0m\n" "$1"; }

say "1/5  Checking your data bundle"
if [ -f public/chain_bundle.json ]; then
  SIZE=$(du -m public/chain_bundle.json | cut -f1)
  echo "  public/chain_bundle.json — ${SIZE} MB"
  if [ "$SIZE" -gt 45 ]; then
    warn "Over 45 MB. GitHub refuses files above 100 MB and the site will load slowly."
    warn "Rebuild smaller:  python3 -m optdata.cli bundle --spot nifty50_daily_combined.csv \\"
    warn "                    --out chain_bundle.json --lookback 8 --window 5"
    warn "Or keep it out of git:  echo 'public/chain_bundle.json' >> .gitignore"
    read -p "  Continue anyway? [y/N] " go
    [ "$go" = "y" ] || exit 1
  fi
else
  warn "No public/chain_bundle.json — the site will deploy with the file picker instead."
  warn "To ship your data with it:  cp ../nifty-option-backtester/chain_bundle.json public/"
fi

say "2/5  Installing dependencies"
npm install --silent

say "3/5  Building"
npm run build

say "4/5  Committing"
if [ ! -d .git ]; then
  git init -q
  git branch -M main
  echo "  new repository created"
fi
git add -A
if git diff --cached --quiet; then
  echo "  nothing changed since the last commit"
else
  MSG="${1:-update $(date '+%d %b %Y %H:%M')}"
  git commit -q -m "$MSG"
  echo "  committed: $MSG"
fi
if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main && echo "  pushed to GitHub — Vercel will redeploy on its own"
else
  warn "No GitHub remote set. Skipping push (Vercel CLI deploy below still works)."
  warn "To add one:  git remote add origin https://github.com/<you>/nifty-sim.git"
fi

say "5/5  Deploying to Vercel"
npx --yes vercel@latest --prod

say "Done."
