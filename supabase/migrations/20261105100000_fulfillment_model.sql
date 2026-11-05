-- Fulfillment phase 1, task 1: per-tenant order statuses mapped to fixed
-- categories/steps, per-tenant settings, order event log, new columns.
-- Tables are read-only for API roles (no insert/update/delete policies);
-- writes go through security definer functions.

-- ============================================================
-- order_statuses
-- ============================================================
create table public.order_statuses (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null check (key ~ '^[a-z_]{1,50}$'),
  label text not null check (char_length(label) between 1 and 100),
  category text not null
    check (category in ('to_confirm', 'preparing', 'in_transit', 'delivered', 'cancelled')),
  step text
    check (step in ('created', 'confirmed', 'accepted', 'picked_up', 'delivery_failed',
                    'delivered', 'partially_delivered', 'cancelled')),
  position int not null,
  primary key (tenant_id, key)
);
create unique index order_statuses_tenant_step_key
  on public.order_statuses (tenant_id, step) where step is not null;

alter table public.order_statuses enable row level security;
create policy order_statuses_select on public.order_statuses
  for select to authenticated
  using (tenant_id = (select public.tenant_id()));

-- ============================================================
-- tenant_order_settings
-- ============================================================
create table public.tenant_order_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  require_driver_acceptance boolean not null default true,
  require_signature boolean not null default true,
  require_receiver_name boolean not null default true,
  require_photo boolean not null default false
);

alter table public.tenant_order_settings enable row level security;
create policy tenant_order_settings_select on public.tenant_order_settings
  for select to authenticated
  using (tenant_id = (select public.tenant_id()));

-- ============================================================
-- Seeding (new tenants + backfill)
-- ============================================================
create or replace function public.seed_order_statuses(p_tenant_id uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.order_statuses (tenant_id, key, label, category, step, position)
  values
    (p_tenant_id, 'pending',             'Pedido',             'to_confirm', 'created',             1),
    (p_tenant_id, 'confirmed',           'Confirmado',         'preparing',  'confirmed',           2),
    (p_tenant_id, 'accepted',            'Aceptado por chofer','preparing',  'accepted',            3),
    (p_tenant_id, 'dispatched',          'En camino',          'in_transit', 'picked_up',           4),
    (p_tenant_id, 'delivery_failed',     'Entrega fallida',    'in_transit', 'delivery_failed',     5),
    (p_tenant_id, 'delivered',           'Entregado',          'delivered',  'delivered',           6),
    (p_tenant_id, 'partially_delivered', 'Entregado parcial',  'delivered',  'partially_delivered', 7),
    (p_tenant_id, 'cancelled',           'Cancelado',          'cancelled',  'cancelled',           8)
  on conflict do nothing;
  insert into public.tenant_order_settings (tenant_id) values (p_tenant_id)
  on conflict do nothing;
$$;
revoke execute on function public.seed_order_statuses(uuid) from public, anon, authenticated;

create or replace function public.seed_order_statuses_trigger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.seed_order_statuses(new.id);
  return new;
end;
$$;

create trigger tenants_seed_order_statuses
  after insert on public.tenants
  for each row execute function public.seed_order_statuses_trigger();

select public.seed_order_statuses(id) from public.tenants;

-- ============================================================
-- Lookup helpers
-- ============================================================
create or replace function public.order_status_for_step(p_tenant_id uuid, p_step text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
begin
  select key into v_key from public.order_statuses
  where tenant_id = p_tenant_id and step = p_step;
  if v_key is null then
    raise exception 'tenant has no status for step %', p_step using errcode = '22023';
  end if;
  return v_key;
end;
$$;

create or replace function public.order_category(p_tenant_id uuid, p_status text)
returns text
language sql
stable
set search_path = ''
as $$
  select category from public.order_statuses
  where tenant_id = p_tenant_id and key = p_status
$$;

-- Internal helpers: only security definer functions call them.
revoke execute on function public.order_status_for_step(uuid, text) from public, anon, authenticated;
revoke execute on function public.order_category(uuid, text) from public, anon, authenticated;

-- ============================================================
-- orders / order_items / users columns
-- ============================================================
alter table public.users add constraint users_tenant_id_id_key unique (tenant_id, id);

alter table public.orders drop constraint orders_status_check;
alter table public.orders
  add constraint orders_status_fkey foreign key (tenant_id, status)
    references public.order_statuses (tenant_id, key),
  add column driver_id uuid,
  add column delivery_date date,
  add column delivery_window text check (char_length(delivery_window) <= 100),
  add column status_changed_at timestamptz not null default now(),
  add column invoice_status text not null default 'not_invoiced'
    check (invoice_status in ('not_invoiced', 'pending', 'issued', 'error')),
  add constraint orders_driver_fkey foreign key (tenant_id, driver_id)
    references public.users (tenant_id, id);
create index orders_tenant_driver_idx on public.orders (tenant_id, driver_id);

alter table public.order_items
  add column delivered_quantity numeric(10,2)
    check (delivered_quantity >= 0 and delivered_quantity <> 'NaN'::numeric),
  add column shortfall_reason text
    check (shortfall_reason in ('refused', 'damaged', 'short', 'other')),
  add column shortfall_note text check (char_length(shortfall_note) <= 200),
  add constraint order_items_delivered_le_quantity check (delivered_quantity <= quantity);

-- ============================================================
-- order_events
-- ============================================================
create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  action text not null
    check (action in ('create', 'assign', 'reject', 'accept', 'pick_up', 'deliver', 'fail', 'cancel', 'correct')),
  from_status text,
  to_status text not null,
  actor_id uuid references public.users (id) on delete set null,
  reason text,
  note text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index order_events_order_idx on public.order_events (tenant_id, order_id, created_at);

alter table public.order_events enable row level security;
create policy order_events_select on public.order_events
  for select to authenticated
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));

-- Internal: transition RPCs call it after changing the order. p_order is the
-- row AFTER the change, so to_status = p_order.status.
create or replace function public.log_order_event(
  p_order public.orders, p_action text, p_from text, p_reason text, p_note text, p_payload jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.order_events (tenant_id, order_id, action, from_status, to_status, actor_id, reason, note, payload)
  values (p_order.tenant_id, p_order.id, p_action, p_from, p_order.status, auth.uid(), p_reason, p_note,
          coalesce(p_payload, '{}'::jsonb))
$$;
revoke execute on function public.log_order_event(public.orders, text, text, text, text, jsonb)
  from public, anon, authenticated;

-- create_order() is security invoker and cannot call log_order_event, so the
-- create event comes from this trigger (covers every insert path).
create or replace function public.log_order_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.log_order_event(new, 'create', null, null, null, null);
  return new;
end;
$$;

create trigger orders_log_created
  after insert on public.orders
  for each row execute function public.log_order_created();
