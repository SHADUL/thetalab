#!/usr/bin/env bash
# Copy the Supabase 'public' schema + data into the self-hosted database.
# YOU run this on the VM: it asks for your Supabase connection string (Supabase → Connect →
# "Session pooler" URI, with your database password filled in). It is read silently, used once by
# pg_dump inside a throwaway container, and never written to disk or printed.
# Safe to re-run: the restore replaces existing objects (--clean --if-exists).
set -euo pipefail
cd /opt/thetalab
DUMP=data/migration/supabase-public.dump
read -rsp "Supabase session-pooler connection string: " SRC; echo
export SRC
echo "dumping public schema from Supabase…"
sudo docker run --rm -e SRC postgres:17-alpine sh -c 'pg_dump "$SRC" --schema=public --no-owner --no-privileges --format=custom' > "$DUMP"
unset SRC
chmod 600 "$DUMP"
echo "dump: $(du -h "$DUMP" | cut -f1)"
echo "restoring into thetalab-db…"
sudo docker exec -i thetalab-db pg_restore -U postgres -d thetalab --no-owner --no-privileges --clean --if-exists --exit-on-error < "$DUMP" || {
  echo "pg_restore with --exit-on-error failed; retrying without it to list every error"; sudo docker exec -i thetalab-db pg_restore -U postgres -d thetalab --no-owner --no-privileges --clean --if-exists < "$DUMP"; }
sudo docker exec -i thetalab-db psql -v ON_ERROR_STOP=1 -U postgres -d thetalab < app/deploy/oracle/db/grants.sql
echo "row counts (self-hosted):"
sudo docker exec thetalab-db psql -U postgres -d thetalab -At -F' ' -c "select table_name, (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(table_name), false, true, '')))[1]::text::bigint from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1" > data/migration/counts.txt
wc -l < data/migration/counts.txt | xargs echo "tables restored:"
echo "done — counts in /opt/thetalab/data/migration/counts.txt"
