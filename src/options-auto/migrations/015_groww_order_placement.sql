-- Real Groww order-placement support. Additive only.
--
-- Which broker actually holds a position — recorded ONCE, at open, same
-- discipline as execution_mode (a position's mode never changes after
-- open even if the dashboard toggle later moves). This is what
-- position-monitor's real-order closing path must key off, NOT whatever
-- options_autotrade_settings.active_broker currently says — the active
-- broker can change after this position opened, but its real order still
-- lives at whichever broker actually placed it.
alter table options_autotrade_positions
  add column if not exists broker text not null default 'KITE'
    check (broker in ('KITE', 'GROWW'));

-- Groww's own instrument master, scoped to exactly the three symbols this
-- app trades (NIFTY/BANKNIFTY/SENSEX FNO) — mirrors options_instruments'
-- shape/purpose but stores Groww's OWN trading_symbol (a different string
-- format from Kite's, e.g. "NIFTY26O0622700PE"), since real order
-- placement through Groww must use Groww's own symbol, not Kite's.
create table groww_options_instruments (
  id bigint generated always as identity primary key,
  symbol text not null, -- NIFTY | BANKNIFTY | SENSEX (underlying_symbol)
  exchange text not null,
  trading_symbol text not null,
  expiry date not null,
  strike numeric not null,
  option_right text not null check (option_right in ('CE', 'PE')),
  lot_size integer not null,
  last_synced_at timestamptz not null default now(),
  unique (symbol, expiry, strike, option_right)
);
create index groww_options_instruments_lookup_idx on groww_options_instruments (symbol, expiry, strike, option_right);
alter table groww_options_instruments enable row level security;
