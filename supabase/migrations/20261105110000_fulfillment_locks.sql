-- Fulfillment phase 1, task 2: status/driver/delivery columns are written
-- only by security definer functions; the order can't be edited once it left.

-- ============================================================
-- Column privileges (RLS still applies on top)
-- ============================================================
revoke insert, update on public.orders from authenticated, anon;
-- created_by: create_order() writes it (a trigger overwrites it anyway).
grant insert (tenant_id, customer_id, created_by, notes, channel) on public.orders to authenticated;
grant update (customer_id, notes) on public.orders to authenticated;

revoke insert, update on public.order_items from authenticated, anon;
-- delivered_quantity/shortfall_* are not insertable either; price_overridden_*
-- are accepted but the stamp trigger nulls them on insert.
grant insert (tenant_id, order_id, product_id, quantity, price_at_order, unit_at_order,
              price_overridden_by, price_overridden_at)
  on public.order_items to authenticated;
-- price_overridden_*: update_order_detail() sets them (a trigger decides them).
grant update (product_id, quantity, price_at_order, unit_at_order,
              price_overridden_by, price_overridden_at)
  on public.order_items to authenticated;

-- ============================================================
-- Edit lock: security definer because order_category() is not executable by
-- authenticated. Only user sessions (auth.uid()) at trigger depth 1 are locked.
-- ============================================================
create or replace function public.orders_edit_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if public.order_category(old.tenant_id, old.status) in ('in_transit', 'delivered', 'cancelled') then
    raise exception 'El pedido ya salió; no se puede editar.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger orders_edit_lock
  before update of customer_id, notes on public.orders
  for each row execute function public.orders_edit_lock();

create or replace function public.order_items_edit_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from public.orders o
    where o.id = v_order_id
      and public.order_category(o.tenant_id, o.status) in ('in_transit', 'delivered', 'cancelled')
  ) then
    raise exception 'El pedido ya salió; no se puede editar.' using errcode = '22023';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger order_items_edit_lock
  before insert or update of product_id, quantity, price_at_order, unit_at_order or delete
  on public.order_items
  for each row execute function public.order_items_edit_lock();

-- ============================================================
-- Touch the order so the driver (no policy on order_items) gets a Realtime event
-- ============================================================
create or replace function public.order_items_touch_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.orders set updated_at = now() where id = new.order_id;
  return null;
end;
$$;

create trigger order_items_touch_order
  after insert or update on public.order_items
  for each row execute function public.order_items_touch_order();
