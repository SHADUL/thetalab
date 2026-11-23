#!/usr/bin/env bash
# Switch ThetaLab from Supabase to the self-hosted database. Run OUTSIDE market hours.
#  1. stop the app + worker (no writes to Supabase during the copy)
#  2. final copy (migrate.sh asks for your connection string)
#  3. point SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY at the self-hosted API (old values kept in a backup)
#  4. start everything
set -euo pipefail
cd /opt/thetalab
BK=".env.bak.pre-selfhost.$(date +%Y%m%d-%H%M%S)"
cp -p .env "$BK"; echo "backup: $BK"
sudo docker compose stop thetalab-web thetalab-worker
bash app/deploy/oracle/db/migrate.sh
bash app/deploy/oracle/db/service-key.sh
tmp=$(mktemp -p /opt/thetalab .envtmp.XXXX)
grep -v -E "^SUPABASE_(URL|SERVICE_ROLE_KEY)=" .env > "$tmp" || true
printf "SUPABASE_URL=http://thetalab-dbapi:8080\nSUPABASE_SERVICE_ROLE_KEY=%s\n" "$(cat data/migration/service_role.jwt)" >> "$tmp"
cat "$tmp" > .env; rm -f "$tmp"
echo "SUPABASE_URL now: $(grep '^SUPABASE_URL=' .env)"
sudo docker compose up -d thetalab-web
[ -n "$(sudo docker ps -aq -f name=^thetalab-worker$)" ] && sudo docker compose --profile worker up -d thetalab-worker || true
sudo docker compose ps
echo "cut-over complete. Rollback: bash app/deploy/oracle/db/rollback.sh $BK"
