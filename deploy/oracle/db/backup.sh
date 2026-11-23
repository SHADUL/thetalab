#!/usr/bin/env bash
# Nightly logical backup of the self-hosted ThetaLab database; keeps 14 days.
set -euo pipefail
cd /opt/thetalab/data/db-backups
f="thetalab-$(date +%Y%m%d-%H%M).dump"
sudo docker exec thetalab-db pg_dump -U postgres -d thetalab --format=custom > "$f"
chmod 600 "$f"
find . -name 'thetalab-*.dump' -mtime +14 -delete
echo "$(date -Is) backup $f $(du -h "$f" | cut -f1)" >> backup.log
