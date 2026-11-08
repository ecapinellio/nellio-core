-- The email and DTE queues are woken up by Supabase, not Vercel Cron
-- (Vercel Hobby only allows daily crons): pg_net calls the app's cron routes
-- right after something is queued, and pg_cron every 5 minutes for retries.
-- Where to call and with what secret live in Vault (set once per project):
--   select vault.create_secret('https://<app domain>', 'app_url');
--   select vault.create_secret('<same value as CRON_SECRET in Vercel>', 'cron_secret');
-- Without them nothing is called (local dev, tests).

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Fire-and-forget GET to the app; pg_net sends it after the transaction commits.
create or replace function public.wake_queue(p_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'app_url');
  v_secret text := (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'cron_secret');
begin
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_get(
    url := rtrim(v_url, '/') || p_path,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 60000
  );
end;
$$;
revoke execute on function public.wake_queue(text) from public, anon, authenticated;

-- Right away when something is queued: once per statement, not per row.
create or replace function public.wake_queue_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.wake_queue(tg_argv[0]);
  return null;
exception when others then
  -- Never blocks the delivery: the 5-minute job picks it up.
  raise warning 'wake_queue % failed: %', tg_argv[0], sqlerrm;
  return null;
end;
$$;
revoke execute on function public.wake_queue_on_insert() from public, anon, authenticated;

create trigger dte_documents_wake
  after insert on public.dte_documents
  for each statement execute function public.wake_queue_on_insert('/api/cron/dte');
create trigger order_notifications_wake
  after insert on public.order_notifications
  for each statement execute function public.wake_queue_on_insert('/api/cron/notifications');

-- Retries (Hacienda down, Resend down, a lost call).
select cron.schedule('wake-dte', '*/5 * * * *', $$select public.wake_queue('/api/cron/dte')$$);
select cron.schedule('wake-notifications', '*/5 * * * *', $$select public.wake_queue('/api/cron/notifications')$$);
