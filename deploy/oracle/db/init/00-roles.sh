#!/bin/sh
# First-start initialisation of the self-hosted ThetaLab database (runs once, on an empty data dir).
# Recreates the role layout Supabase's API expects so PostgREST + supabase-js work unchanged:
#   authenticator  LOGIN, used by PostgREST; switches to the role in the JWT
#   service_role   what the server's key maps to; BYPASSRLS (same as Supabase)
#   anon / authenticated  exist so restored RLS policies resolve; anon gets no data access
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v auth_pw="$AUTHENTICATOR_PASSWORD" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator noinherit login password :'auth_pw';
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
alter role authenticator set statement_timeout = '60s';
SQL
