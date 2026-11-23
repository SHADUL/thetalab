#!/usr/bin/env bash
# One-time: create the database secrets file and data directories on the VM.
# Secrets are generated here, written only to /opt/thetalab/db.env (mode 600) and never printed.
set -euo pipefail
cd /opt/thetalab
if [ -f db.env ]; then echo "db.env already exists — leaving it unchanged"; else
  umask 077
  PG=$(openssl rand -hex 24); AUTH=$(openssl rand -hex 24); JWT=$(openssl rand -hex 32)
  cat > db.env <<ENV
POSTGRES_USER=postgres
POSTGRES_DB=thetalab
POSTGRES_PASSWORD=$PG
AUTHENTICATOR_PASSWORD=$AUTH
PGRST_DB_URI=postgres://authenticator:$AUTH@thetalab-db:5432/thetalab
PGRST_JWT_SECRET=$JWT
ENV
  echo "created db.env (mode $(stat -c %a db.env))"
fi
sudo mkdir -p data/postgres data/db-backups data/migration
sudo chmod 700 data/db-backups data/migration
echo "data dirs ready"
