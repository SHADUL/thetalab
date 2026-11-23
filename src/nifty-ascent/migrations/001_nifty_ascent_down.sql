-- Rollback for 001_nifty_ascent.sql. PERMANENTLY deletes all NIFTY ASCENT
-- paper sessions, events, orders and trades. Run only if you want them gone.
drop table if exists nifty_ascent_trades;
drop table if exists nifty_ascent_orders;
drop table if exists nifty_ascent_events;
drop table if exists nifty_ascent_sessions;
drop table if exists nifty_ascent_control;
