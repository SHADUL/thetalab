-- Additive. Read-only feature snapshots published by the Alpha Ladder worker
-- once a minute for OBSERVE-ONLY consumers (Options Auto-Trader experiment).
-- Nothing here feeds back into Alpha Ladder's signal; nothing in the signal
-- path reads this table.
create table if not exists alpha_ladder_order_flow_features (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  session_date date not null,
  worker_instance text,
  as_of_sec numeric not null,            -- seconds since the 09:15 IST session origin
  g1 numeric, a1 numeric not null, d1 smallint not null,
  g2 numeric, a2 numeric not null, d2 smallint not null,
  d2_basis text not null,                -- crossing | cutoff_area | running_area (provisional)
  g2_crossed boolean not null,
  crossing_value numeric,
  alpha smallint,                        -- 1 aligned, 0 divergent, null while d1 = 0
  base_direction smallint,               -- D0
  final_direction smallint,              -- D (after Variation C)
  variation_c_acted boolean not null,
  vix_available boolean not null,
  g1_active boolean not null,            -- theta2 warm-up met on both sides
  session_valid boolean not null,        -- false after a late start / unrecoverable gap
  session_integrity_reason text
);
create index if not exists alpha_ladder_order_flow_features_time_idx on alpha_ladder_order_flow_features (created_at desc);
alter table alpha_ladder_order_flow_features enable row level security;
