#!/usr/bin/env bash
# Point ThetaLab back at Supabase using the .env backup taken by cutover.sh.
# Anything written to the self-hosted database after the cut-over is NOT copied back.
set -euo pipefail
cd /opt/thetalab
BK=${1:?usage: rollback.sh .env.bak.pre-selfhost.<timestamp>}
cp -p "$BK" .env
sudo docker compose up -d --force-recreate thetalab-web
[ -n "$(sudo docker ps -aq -f name=^thetalab-worker$)" ] && sudo docker compose --profile worker up -d --force-recreate thetalab-worker || true
echo "rolled back to Supabase: $(grep '^SUPABASE_URL=' .env | sed 's#//.*@#//***@#')"
