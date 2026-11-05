-- Driver side: see own orders, accept/reject an assignment, pick up in batch.
-- The driver has no policy on order_items or customers; list_driver_orders()
-- (definer) is the only way to read lines, address and phone, without line prices.

-- Active orders, plus closed ones for 7 days. Subquery instead of order_category():
-- policies run as the caller, who cannot execute the internal helpers.
create policy orders_select_own_driver on public.orders
  for select to authenticated
  using (
    tenant_id = (select public.tenant_id())
    and (select public.role()) = 'driver'
    and driver_id = (select auth.uid())
    and exists (
      select 1 from public.order_statuses s
      where s.tenant_id = orders.tenant_id and s.key = orders.status
        and (
          s.category in ('preparing', 'in_transit')
          or (s.category in ('delivered', 'cancelled') and orders.status_changed_at > now() - interval '7 days')
        )
    )
  );

create or replace function public.respond_to_assignment(
  p_order_id uuid,
  p_accept boolean,
  p_expected_status text
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_order public.orders;
  v_from text;
  v_step text;
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_order from public.orders o
  where o.id = p_order_id and o.tenant_id = v_tenant_id
  for update;
  if not found then
    raise exception 'Order not found for this tenant' using errcode = 'P0002';
  end if;

  if public.role() is distinct from 'driver' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  -- Someone else's order looks the same as a missing one.
  if v_order.driver_id is distinct from auth.uid() then
    raise exception 'Order not found for this tenant' using errcode = 'P0002';
  end if;

  if v_order.status is distinct from p_expected_status then
    raise exception 'Order status changed' using errcode = 'PT409';
  end if;

  if p_accept is null then
    raise exception 'Accept or reject is required' using errcode = '22004';
  end if;

  v_from := v_order.status;
  select s.step into v_step from public.order_statuses s
  where s.tenant_id = v_tenant_id and s.key = v_from;
  if v_step is null or v_step not in ('confirmed') then
    raise exception 'Cannot respond to an order in step %', v_step using errcode = '22023';
  end if;

  if p_accept then
    update public.orders
    set status = public.order_status_for_step(v_tenant_id, 'accepted'), status_changed_at = now()
    where id = v_order.id
    returning * into v_order;
    perform public.log_order_event(v_order, 'accept', v_from, null, null, null);
  else
    update public.orders
    set driver_id = null, status_changed_at = now()
    where id = v_order.id
    returning * into v_order;
    perform public.log_order_event(v_order, 'reject', v_from, null, null,
      jsonb_build_object('driver_id', auth.uid()));
  end if;
  return v_order;
end;
$$;

create or replace function public.pick_up_orders(p_order_ids uuid[])
returns setof public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_ids uuid[];
  v_id uuid;
  v_order public.orders;
  v_from text;
  v_step text;
  v_needs_accept boolean;
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    raise exception 'No orders given' using errcode = '22023';
  end if;

  -- Lock in id order so two concurrent batches cannot deadlock.
  select array_agg(o.id order by o.id) into v_ids from (
    select o.id from public.orders o
    where o.id = any (p_order_ids) and o.tenant_id = v_tenant_id
    order by o.id
    for update
  ) o;
  if coalesce(cardinality(v_ids), 0) <> (select count(distinct x) from unnest(p_order_ids) x) then
    raise exception 'Order not found for this tenant' using errcode = 'P0002';
  end if;

  if public.role() is distinct from 'driver' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select coalesce((select t.require_driver_acceptance from public.tenant_order_settings t
                   where t.tenant_id = v_tenant_id), true) into v_needs_accept;

  foreach v_id in array v_ids
  loop
    select * into v_order from public.orders o where o.id = v_id;
    if v_order.driver_id is distinct from auth.uid() then
      raise exception 'Order not found for this tenant' using errcode = 'P0002';
    end if;
    v_from := v_order.status;
    select s.step into v_step from public.order_statuses s
    where s.tenant_id = v_tenant_id and s.key = v_from;
    if v_step is null or not (v_step = 'accepted' or (v_step = 'confirmed' and not v_needs_accept)) then
      raise exception 'Cannot pick up an order in step %', v_step using errcode = '22023';
    end if;

    update public.orders
    set status = public.order_status_for_step(v_tenant_id, 'picked_up'), status_changed_at = now()
    where id = v_order.id
    returning * into v_order;
    perform public.log_order_event(v_order, 'pick_up', v_from, null, null, null);
    return next v_order;
  end loop;
end;
$$;

create or replace function public.list_driver_orders()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.role() is distinct from 'driver' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'status_label', s.label,
      'category', s.category,
      'delivery_date', o.delivery_date,
      'delivery_window', o.delivery_window,
      'notes', o.notes,
      'status_changed_at', o.status_changed_at,
      'customer', jsonb_build_object('name', c.name, 'address', c.address, 'phone', c.phone),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id, 'product_name', p.name, 'quantity', i.quantity,
          'unit', i.unit_at_order, 'delivered_quantity', i.delivered_quantity
        ) order by i.created_at, i.id)
        from public.order_items i join public.products p on p.id = i.product_id
        where i.order_id = o.id
      ), '[]'::jsonb),
      'total', (
        select case when count(*) = 0 or bool_or(i.price_at_order is null) then null
                    else sum(i.quantity * i.price_at_order) end
        from public.order_items i where i.order_id = o.id
      ),
      'attempt', (select count(*) from public.order_events e where e.order_id = o.id and e.action = 'pick_up')
    ) order by o.delivery_date, o.created_at, o.id)
    from public.orders o
    join public.order_statuses s on s.tenant_id = o.tenant_id and s.key = o.status
    join public.customers c on c.id = o.customer_id
    where o.tenant_id = v_tenant_id and o.driver_id = auth.uid()
      and (s.category in ('preparing', 'in_transit')
           or (s.category in ('delivered', 'cancelled') and o.status_changed_at > now() - interval '7 days'))
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.respond_to_assignment(uuid, boolean, text) from public, anon;
revoke execute on function public.pick_up_orders(uuid[]) from public, anon;
revoke execute on function public.list_driver_orders() from public, anon;
grant execute on function public.respond_to_assignment(uuid, boolean, text) to authenticated;
grant execute on function public.pick_up_orders(uuid[]) to authenticated;
grant execute on function public.list_driver_orders() to authenticated;
