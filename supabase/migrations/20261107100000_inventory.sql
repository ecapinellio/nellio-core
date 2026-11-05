-- Inventory (ADR-014): stock = sum of inventory_movements. One warehouse,
-- quantities only (no cost, no lots). Orders move stock through a trigger
-- that reconciles each order's movements with its current state, so every
-- transition (pick up, delivery, failure, cancel, admin correction) is covered
-- without touching the transition functions.

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  product_id uuid not null references public.products (id),
  -- signed: + enters the warehouse, - leaves it
  quantity numeric(12, 2) not null
    check (quantity <> 0 and quantity <> 'NaN'::numeric and abs(quantity) < 1000000000),
  kind text not null check (kind in ('receipt', 'count', 'order')),
  order_id uuid references public.orders (id) on delete cascade,
  note text check (char_length(note) <= 200),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'order') = (order_id is not null))
);
create index inventory_movements_product_idx on public.inventory_movements (tenant_id, product_id, created_at);
create index inventory_movements_order_idx on public.inventory_movements (order_id) where order_id is not null;

alter table public.inventory_movements enable row level security;
create policy inventory_movements_select on public.inventory_movements
  for select to authenticated
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
-- Only save_stock_movements() and the order trigger write.
revoke all on public.inventory_movements from anon, authenticated;
grant select on public.inventory_movements to authenticated;

-- Current stock per product. security_invoker: the caller's RLS applies.
create view public.product_stock
with (security_invoker = on)
as
  select p.id, p.tenant_id, p.name, p.unit, p.active,
         coalesce(sum(m.quantity), 0)::numeric(12, 2) as stock
  from public.products p
  left join public.inventory_movements m on m.product_id = p.id
  group by p.id;
revoke all on public.product_stock from anon, authenticated;
grant select on public.product_stock to authenticated;

-- ============================================================
-- Orders → stock
-- ============================================================
-- How much of each product this order has taken out of the warehouse, given
-- its current state:
--   before leaving / failed delivery / cancelled → 0 (it's in the warehouse)
--   in transit → the ordered quantity
--   delivered → what the customer got + what got damaged (lost);
--               refused/short/other came back
create or replace function public.sync_order_inventory(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_category text;
  v_step text;
begin
  select o.tenant_id, s.category, s.step into v_tenant_id, v_category, v_step
  from public.orders o
  join public.order_statuses s on s.tenant_id = o.tenant_id and s.key = o.status
  where o.id = p_order_id;
  if not found then
    return;
  end if;

  -- Serialize with save_stock_movements() counts on the same products.
  -- no key update: doesn't block the FK checks of order_items.
  perform 1 from public.products p
  where p.id in (select i.product_id from public.order_items i where i.order_id = p_order_id
                 union select m.product_id from public.inventory_movements m where m.order_id = p_order_id)
  order by p.id
  for no key update;

  insert into public.inventory_movements (tenant_id, product_id, quantity, kind, order_id, created_by)
  select v_tenant_id, coalesce(t.product_id, c.product_id),
         coalesce(c.taken, 0) - coalesce(t.taken, 0), 'order', p_order_id, auth.uid()
  from (
    select i.product_id, sum(case
      when v_category = 'in_transit' and v_step is distinct from 'delivery_failed' then i.quantity
      when v_category = 'delivered' then
        coalesce(i.delivered_quantity, i.quantity)
        + case when i.shortfall_reason = 'damaged' then i.quantity - coalesce(i.delivered_quantity, i.quantity) else 0 end
      else 0 end) as taken
    from public.order_items i where i.order_id = p_order_id
    group by i.product_id
  ) t
  full join (
    select m.product_id, -sum(m.quantity) as taken
    from public.inventory_movements m where m.order_id = p_order_id
    group by m.product_id
  ) c on c.product_id = t.product_id
  where coalesce(c.taken, 0) <> coalesce(t.taken, 0);
end;
$$;
revoke execute on function public.sync_order_inventory(uuid) from public, anon, authenticated;

create or replace function public.orders_sync_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_order_inventory(new.id);
  return null;
end;
$$;

create trigger orders_sync_inventory
  after update of status on public.orders
  for each row when (old.status is distinct from new.status)
  execute function public.orders_sync_inventory();

create or replace function public.order_items_sync_inventory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A cascade (order or tenant deleted) takes the movements with it.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.sync_order_inventory(coalesce(new.order_id, old.order_id));
  return null;
end;
$$;

create trigger order_items_sync_inventory
  after insert or delete or update of product_id, quantity, delivered_quantity, shortfall_reason
  on public.order_items
  for each row execute function public.order_items_sync_inventory();

-- ============================================================
-- Receipts and physical counts (admin only)
-- ============================================================
-- p_rows: [{product_id, kind: 'receipt' | 'count', quantity, note?}]
--   receipt: quantity > 0 enters the warehouse
--   count:   quantity >= 0 is what was counted; the difference is recorded
-- Returns the number of movements written (a count that matches writes none).
create or replace function public.save_stock_movements(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_row jsonb;
  v_product_id uuid;
  v_kind text;
  v_qty numeric;
  v_note text;
  v_delta numeric;
  v_written int := 0;
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.role() is distinct from 'admin' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 1000 then
    raise exception 'Rows must be a non-empty array of at most 1000' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) is distinct from 'object'
       or jsonb_typeof(v_row -> 'product_id') is distinct from 'string'
       or jsonb_typeof(v_row -> 'quantity') is distinct from 'number'
       or (v_row ->> 'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid row' using errcode = '22023';
    end if;
    v_kind := v_row ->> 'kind';
    v_qty := (v_row ->> 'quantity')::numeric;
    v_note := nullif(btrim(v_row ->> 'note'), '');
    if v_kind is null or v_kind not in ('receipt', 'count') then
      raise exception 'Invalid kind' using errcode = '22023';
    end if;
    if v_qty <> round(v_qty, 2) or v_qty >= 1000000000
       or (v_kind = 'receipt' and v_qty <= 0) or (v_kind = 'count' and v_qty < 0) then
      raise exception 'Invalid quantity' using errcode = '22023';
    end if;
    if char_length(v_note) > 200 then
      raise exception 'Text too long' using errcode = '22023';
    end if;

    select p.id into v_product_id from public.products p
    where p.id = (v_row ->> 'product_id')::uuid and p.tenant_id = v_tenant_id
    for no key update;
    if not found then
      raise exception 'Product not found for this tenant' using errcode = 'P0002';
    end if;

    if v_kind = 'receipt' then
      v_delta := v_qty;
    else
      select v_qty - coalesce(sum(m.quantity), 0) into v_delta
      from public.inventory_movements m where m.product_id = v_product_id;
    end if;

    if v_delta <> 0 then
      insert into public.inventory_movements (tenant_id, product_id, quantity, kind, note, created_by)
      values (v_tenant_id, v_product_id, v_delta, v_kind, v_note, auth.uid());
      v_written := v_written + 1;
    end if;
  end loop;
  return v_written;
end;
$$;
revoke execute on function public.save_stock_movements(jsonb) from public, anon;
grant execute on function public.save_stock_movements(jsonb) to authenticated;

-- Orders that already left before inventory existed: record what they took,
-- so stock = sum still holds and later returns add back correctly. The
-- admin's first count then sets the real starting stock.
select public.sync_order_inventory(o.id) from public.orders o;
update public.inventory_movements set note = 'Pedido anterior al inventario' where kind = 'order';
