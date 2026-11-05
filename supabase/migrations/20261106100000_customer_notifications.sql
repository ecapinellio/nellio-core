-- Fulfillment phase 2 (spec 2026-11-04 §10): customer emails + public tracking page.
--
-- Emails go through an outbox: a trigger on order_events queues one row per
-- email in the same transaction as the status change, and the cron route
-- (app/api/cron/notifications) sends them. A failed email never blocks or
-- undoes a transition.

-- ============================================================
-- Tracking token: the unguessable part of /t/<token> (ADR-008's "paso intermedio")
-- ============================================================
-- Two v4 UUIDs = 244 random bits. Not granted for insert/update to API roles
-- (20261105110000 uses column grants), so only this default sets it.
alter table public.orders
  add column tracking_token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

-- ============================================================
-- Which order_events actions email the customer (spec §11, per-company switch)
-- ============================================================
alter table public.tenant_order_settings
  add column customer_email_actions text[] not null
    default '{create,assign,pick_up,deliver,fail,cancel}'
    check (customer_email_actions <@ '{create,assign,pick_up,deliver,fail,cancel}'::text[]);

-- ============================================================
-- Outbox
-- ============================================================
create table public.order_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  event_id uuid not null unique references public.order_events (id) on delete cascade,
  kind text not null check (kind in (
    'received', 'confirmed', 'rescheduled', 'on_the_way',
    'delivered', 'partially_delivered', 'failed', 'cancelled'
  )),
  recipient text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index order_notifications_order_idx on public.order_notifications (tenant_id, order_id);
create index order_notifications_pending_idx on public.order_notifications (next_attempt_at)
  where status = 'pending';

alter table public.order_notifications enable row level security;
create policy order_notifications_select on public.order_notifications
  for select to authenticated
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
-- Only the trigger (definer) and the sender (service_role) write.
revoke all on public.order_notifications from anon, authenticated;
grant select on public.order_notifications to authenticated;

create or replace function public.enqueue_customer_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actions text[];
  v_email text;
  v_kind text;
begin
  select coalesce(
    (select s.customer_email_actions from public.tenant_order_settings s where s.tenant_id = new.tenant_id),
    '{create,assign,pick_up,deliver,fail,cancel}'
  ) into v_actions;
  if not (new.action = any (v_actions)) then
    return new;
  end if;

  select nullif(btrim(c.email), '') into v_email
  from public.orders o join public.customers c on c.id = o.customer_id
  where o.id = new.order_id;
  if v_email is null then
    return new;
  end if;

  v_kind := case new.action
    when 'create' then 'received'
    -- Only a first confirmation or a reprogram tells the customer something;
    -- a reassignment (confirmed/accepted -> confirmed) does not.
    when 'assign' then (
      select case s.step when 'created' then 'confirmed' when 'delivery_failed' then 'rescheduled' end
      from public.order_statuses s
      where s.tenant_id = new.tenant_id and s.key = new.from_status
    )
    when 'pick_up' then 'on_the_way'
    when 'deliver' then case when (new.payload ->> 'partial')::boolean then 'partially_delivered' else 'delivered' end
    when 'fail' then 'failed'
    when 'cancel' then 'cancelled'
  end;
  if v_kind is null then
    return new;
  end if;

  insert into public.order_notifications (tenant_id, order_id, event_id, kind, recipient)
  values (new.tenant_id, new.order_id, new.id, v_kind, v_email);
  return new;
exception when others then
  -- Anti-goal (spec §2): an email problem never blocks a status change.
  raise warning 'enqueue_customer_email failed for event %: %', new.id, sqlerrm;
  return new;
end;
$$;
revoke execute on function public.enqueue_customer_email() from public, anon, authenticated;

create trigger order_events_enqueue_customer_email
  after insert on public.order_events
  for each row execute function public.enqueue_customer_email();

-- Sender (service_role only): takes up to p_limit due rows, bumps attempts and
-- pushes next_attempt_at, so a concurrent run or a crash mid-send doesn't
-- resend before the retry delay.
create or replace function public.claim_order_notifications(p_limit int)
returns setof public.order_notifications
language sql
set search_path = ''
as $$
  update public.order_notifications n
  set attempts = n.attempts + 1,
      next_attempt_at = now() + interval '15 minutes'
  where n.id in (
    select q.id from public.order_notifications q
    where q.status = 'pending' and q.next_attempt_at <= now()
    order by q.created_at
    limit p_limit
    for update skip locked
  )
  returning n.*
$$;
revoke execute on function public.claim_order_notifications(int) from public, anon, authenticated;
grant execute on function public.claim_order_notifications(int) to service_role;

-- ============================================================
-- Public tracking page data (spec §10)
-- ============================================================
-- No prices, signature, photo or customer data; driver's first name only.
-- Dead 30 days after the order closes (delivered or cancelled). null = not found.
create or replace function public.get_order_tracking(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_status public.order_statuses;
begin
  if p_token is null or char_length(p_token) <> 64 then
    return null;
  end if;

  select * into v_order from public.orders o where o.tracking_token = p_token;
  if not found then
    return null;
  end if;

  select * into v_status from public.order_statuses s
  where s.tenant_id = v_order.tenant_id and s.key = v_order.status;
  if v_status.category in ('delivered', 'cancelled') and v_order.status_changed_at < now() - interval '30 days' then
    return null;
  end if;

  return jsonb_build_object(
    'company', (select coalesce(nullif(btrim(t.commercial_name), ''), t.name) from public.tenants t where t.id = v_order.tenant_id),
    'order_ref', left(v_order.id::text, 8),
    'status_label', v_status.label,
    'category', v_status.category,
    'step', v_status.step,
    'delivery_date', v_order.delivery_date,
    'delivery_window', v_order.delivery_window,
    'driver_first_name', (select split_part(btrim(u.name), ' ', 1) from public.users u where u.id = v_order.driver_id),
    'delivery', (
      select jsonb_build_object('receiver_name', d.receiver_name, 'delivered_at', d.created_at)
      from public.order_deliveries d
      where d.order_id = v_order.id and d.outcome <> 'failed'
      order by d.created_at desc limit 1
    ),
    -- Only events that changed the status: hides reassignments and rejections.
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('status_label', coalesce(s.label, e.to_status), 'at', e.created_at) order by e.created_at)
      from public.order_events e
      left join public.order_statuses s on s.tenant_id = e.tenant_id and s.key = e.to_status
      where e.order_id = v_order.id and e.to_status is distinct from e.from_status
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.get_order_tracking(text) from public;
grant execute on function public.get_order_tracking(text) to anon, authenticated;
