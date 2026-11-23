#!/usr/bin/env bash
# Deploy the committed HEAD to the Oracle VM: ship the tree, rebuild, restart.
# Usage: deploy/oracle/deploy.sh [--with-worker]
set -euo pipefail
# NEVER chown /opt/thetalab/data: it holds the Postgres data dir (uid 70) and other service-owned files.
HOST=${THETALAB_HOST:-ubuntu@130.210.19.135}
KEY=${THETALAB_SSH_KEY:-$HOME/.ssh/apex_oracle}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
cd "$(git rev-parse --show-toplevel)"
REV=$(git rev-parse --short HEAD)
echo "Deploying $REV to $HOST"
"${SSH[@]}" 'sudo mkdir -p /opt/thetalab && sudo chown ubuntu:ubuntu /opt/thetalab && sudo find /opt/thetalab -mindepth 1 -maxdepth 1 ! -name data -exec chown -R ubuntu:ubuntu {} + && rm -rf /opt/thetalab/app.new && mkdir -p /opt/thetalab/app.new'
git archive --format=tar HEAD | "${SSH[@]}" 'tar -x -C /opt/thetalab/app.new'
scp -q -i "$KEY" deploy/oracle/docker-compose.yml "$HOST:/opt/thetalab/docker-compose.yml"
# Database init + gateway config live outside the replaceable app folder.
"${SSH[@]}" "mkdir -p /opt/thetalab/db/init"
scp -q -i "$KEY" deploy/oracle/db/Caddyfile "$HOST:/opt/thetalab/db/Caddyfile"
scp -q -i "$KEY" deploy/oracle/db/init/00-roles.sh "$HOST:/opt/thetalab/db/init/00-roles.sh"
PROFILE=""; [[ "${1:-}" == "--with-worker" ]] && PROFILE="--profile worker"
"${SSH[@]}" "cd /opt/thetalab && test -f .env || { echo 'Missing /opt/thetalab/.env'; exit 1; }
  test -f db.env || { echo 'Missing /opt/thetalab/db.env — run deploy/oracle/db/setup.sh on the VM first'; exit 1; }
  rm -rf app.prev && { [ -d app ] && mv app app.prev || true; } && mv app.new app && echo $REV > app/REVISION
  sudo docker compose $PROFILE build && sudo docker compose $PROFILE up -d --remove-orphans && sudo docker compose ps"
