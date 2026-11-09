#!/usr/bin/env bash
# Deploy the committed HEAD to the Oracle VM: ship the tree, rebuild, restart.
# Usage: deploy/oracle/deploy.sh [--with-worker]
set -euo pipefail
HOST=${THETALAB_HOST:-ubuntu@130.210.19.135}
KEY=${THETALAB_SSH_KEY:-$HOME/.ssh/apex_oracle}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
cd "$(git rev-parse --show-toplevel)"
REV=$(git rev-parse --short HEAD)
echo "Deploying $REV to $HOST"
"${SSH[@]}" 'sudo mkdir -p /opt/thetalab && sudo chown -R ubuntu:ubuntu /opt/thetalab && rm -rf /opt/thetalab/app.new && mkdir -p /opt/thetalab/app.new'
git archive --format=tar HEAD | "${SSH[@]}" 'tar -x -C /opt/thetalab/app.new'
scp -q -i "$KEY" deploy/oracle/docker-compose.yml "$HOST:/opt/thetalab/docker-compose.yml"
PROFILE=""; [[ "${1:-}" == "--with-worker" ]] && PROFILE="--profile worker"
"${SSH[@]}" "cd /opt/thetalab && test -f .env || { echo 'Missing /opt/thetalab/.env'; exit 1; }
  rm -rf app.prev && { [ -d app ] && mv app app.prev || true; } && mv app.new app && echo $REV > app/REVISION
  sudo docker compose $PROFILE build && sudo docker compose $PROFILE up -d --remove-orphans && sudo docker compose ps"
