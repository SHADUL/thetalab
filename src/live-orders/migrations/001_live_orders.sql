-- LIVE ORDERS — real Zerodha order records for NIFTY ASCENT (live mirror) and
-- Naked Sell (LIVE mode). Apply manually (owner). RLS on, no policies: only the
-- server's service role can read or write; the browser never touches these tables.
-- Applying this does NOT turn anything on: the server also needs LIVE_ORDERS=on
-- and each strategy must be ARMED by the owner in the UI.

-- One row per real position (the full order lifecycle is in `data`).
create table if not exists live_positions (
  id            text primary key,                 -- = the Kite order tag of the entry
  strategy      text not null check (strategy in ('NIFTY_ASCENT', 'NAKED_SELL')),
  session_date  date not null,
  status        text not null check (status in ('OPENING', 'OPEN', 'CLOSING', 'CLOSED', 'ENTRY_FAILED', 'CLOSE_FAILED')),
  tradingsymbol text not null,
  net           numeric,
  data          jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists live_positions_day_idx on live_positions (strategy, session_date);
create index if not exists live_positions_status_idx on live_positions (strategy, status);

-- Every broker request and its result (no credentials are ever stored).
create table if not exists live_order_audit (
  id          bigint generated always as identity primary key,
  at          timestamptz not null,
  strategy    text not null,
  position_id text not null,
  action      text not null,
  request     jsonb,
  result      jsonb,
  ok          boolean not null
);
create index if not exists live_order_audit_pos_idx on live_order_audit (position_id);

-- Owner arm switch + live limits per strategy. Disarmed by default.
create table if not exists live_control (
  strategy   text primary key check (strategy in ('NIFTY_ASCENT', 'NAKED_SELL')),
  armed      boolean not null default false,
  armed_at   timestamptz,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into live_control (strategy) values ('NIFTY_ASCENT'), ('NAKED_SELL') on conflict (strategy) do nothing;

-- Naked Sell: allow LIVE rows next to PAPER / SHADOW, linked to their live_positions record.
alter table naked_sell_positions drop constraint if exists naked_sell_positions_mode_check;
alter table naked_sell_positions add constraint naked_sell_positions_mode_check check (mode in ('PAPER', 'SHADOW', 'LIVE'));
alter table naked_sell_positions add column if not exists live_position_id text;

alter table live_positions   enable row level security;
alter table live_order_audit enable row level security;
alter table live_control     enable row level security;

grant all on live_positions, live_order_audit, live_control to service_role;
grant all on all sequences in schema public to service_role;
notify pgrst, 'reload schema';
