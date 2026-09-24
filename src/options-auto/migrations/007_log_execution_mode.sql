-- Tags each log entry with the mode (PAPER | AUTO) it was written under,
-- null for batch-level messages not tied to a single position — see
-- schema.sql's own comment on options_autotrade_log for why. Lets the
-- dashboard's Activity Log filter itself the same way it already filters
-- positions, instead of showing old PAPER chatter mixed into the AUTO view.

alter table options_autotrade_log add column if not exists execution_mode text;
