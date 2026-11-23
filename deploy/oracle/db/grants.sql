-- Run after every restore: the dump is taken with --no-owner --no-privileges.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
-- PostgREST reloads its schema cache on this notification.
notify pgrst, 'reload schema';
