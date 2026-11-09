#!/usr/bin/env bash
# Set the website login (username + password) on the Oracle VM.
#   bash deploy/oracle/set-login.sh
set -euo pipefail
HOST="${THETALAB_HOST:-ubuntu@130.210.19.135}"
KEY="${THETALAB_SSH_KEY:-$HOME/.ssh/apex_oracle}"

read -r -p "New website username: " u
while :; do
  read -rs -p "New website password (hidden): " p; echo
  read -rs -p "Type the password again:       " p2; echo
  [ -n "$p" ] && [ "$p" = "$p2" ] && break
  echo "Passwords empty or did not match - try again."
done

printf 'SITE_BASIC_AUTH_USER=%s\nSITE_BASIC_AUTH_PASS=%s\n' "$u" "$p" | ssh -i "$KEY" "$HOST" '
  set -e; umask 077; f=/opt/thetalab/.env; new=$(cat)
  { grep -Ev "^SITE_BASIC_AUTH_(USER|PASS)=" "$f" || true; printf "%s\n" "$new"; } > "$f.tmp"
  mv "$f.tmp" "$f"; chmod 600 "$f"'
echo "Saved. Tell Claude: done"
