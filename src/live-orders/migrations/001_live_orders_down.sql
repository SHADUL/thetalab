-- Rollback of 001_live_orders.sql. Refuses while any LIVE Naked Sell row exists
-- (delete or keep them consciously first — they are real-money records).
do $$ begin
  if exists (select 1 from naked_sell_positions where mode = 'LIVE') then
    raise exception 'naked_sell_positions has LIVE rows — not rolling back';
  end if;
end $$;
alter table naked_sell_positions drop constraint if exists naked_sell_positions_mode_check;
alter table naked_sell_positions add constraint naked_sell_positions_mode_check check (mode in ('PAPER', 'SHADOW'));
alter table naked_sell_positions drop column if exists live_position_id;
drop table if exists live_control;
drop table if exists live_order_audit;
drop table if exists live_positions;
notify pgrst, 'reload schema';
