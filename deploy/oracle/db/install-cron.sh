#!/usr/bin/env bash
# Installs the ThetaLab DB cron entries for the ubuntu user, keeping any other entries.
set -euo pipefail
cur=$(crontab -l 2>/dev/null | grep -v -F -e "deploy/oracle/db/backup.sh" -e "backfillDailyOhlcv.ts" || true)
{ [ -n "$cur" ] && echo "$cur"; grep -v '^#' /opt/thetalab/app/deploy/oracle/db/crontab.txt | grep -v '^$'; } | crontab -
crontab -l | grep -E "backup.sh|backfillDailyOhlcv"
