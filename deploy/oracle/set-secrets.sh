#!/usr/bin/env bash
# Prompt for the secrets Vercel will not export ("Sensitive" values) and
# write them into /opt/thetalab/.env on the Oracle VM. Input is hidden and
# never touches local disk. Re-running replaces only the keys you fill in;
# press Enter to skip a key (keeps whatever the VM already has).
#
#   bash deploy/oracle/set-secrets.sh
set -euo pipefail

HOST="${THETALAB_HOST:-ubuntu@130.210.19.135}"
KEY="${THETALAB_SSH_KEY:-$HOME/.ssh/apex_oracle}"

ask() { # name, hint
  local v
  printf '%-30s %s\n' "$1" "($2)" >&2
  read -rs -p "  value (Enter = skip): " v; echo >&2
  [ -n "$v" ] && printf '%s=%s\n' "$1" "$v"
  return 0
}

gen() { openssl rand -hex 32; }

{
  ask SITE_BASIC_AUTH_USER          "website login username"
  ask SITE_BASIC_AUTH_PASS          "website login password"
  ask OPTIONS_AUTOTRADE_CRON_SECRET "Bearer token in your cron-job.org headers"
  ask AUTOTRADE_CRON_SECRET         "swing cron token; Enter to skip if unused"
  ask GROWW_API_KEY                 "Groww developer portal"
  ask GROWW_API_SECRET              "Groww developer portal"
  ask GROWW_PROXY_HOST              "proxy dashboard (skip if whitelisting the VM IP)"
  ask GROWW_PROXY_PORT              "proxy dashboard"
  ask GROWW_PROXY_USERNAME          "proxy dashboard"
  ask GROWW_PROXY_PASSWORD          "proxy dashboard"
  ask R2_ACCOUNT_ID                 "Cloudflare R2"
  ask R2_BUCKET_NAME                "Cloudflare R2"
  ask R2_ACCESS_KEY_ID              "Cloudflare R2 API token"
  ask R2_SECRET_ACCESS_KEY          "Cloudflare R2 API token"
  read -r -p "Generate a new SESSION_SECRET? (logs you out once) [Y/n] " g
  case "${g:-Y}" in [Yy]*) printf 'SESSION_SECRET=%s\n' "$(gen)";; esac
} | ssh -i "$KEY" "$HOST" '
  set -e; umask 077; f=/opt/thetalab/.env
  new=$(cat); [ -z "$new" ] && { echo "nothing entered"; exit 0; }
  keys=$(printf "%s\n" "$new" | cut -d= -f1 | paste -sd"|" -)
  { grep -Ev "^($keys)=" "$f" || true; printf "%s\n" "$new"; } > "$f.tmp"
  mv "$f.tmp" "$f"; chmod 600 "$f"
  echo "saved on VM:"; cut -d= -f1 "$f" | sort | paste -sd" " -'
