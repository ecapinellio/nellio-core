-- Office actions on an order: confirm/reassign/reprogram (assign_order),
-- cancel_order, admin correction, and the driver picker.
-- All are security definer (API roles cannot write status/driver_id directly,
-- see 20261105110000), so each checks session, tenant and role itself.

create or replace function public.assign_order(
  p_order_id uuid,
  p_driver_id uuid,
  p_delivery_date date,
  p_delivery_window text,
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
  v_prev uuid;
  v_step text;
  v_window text := nullif(btrim(p_delivery_window), '');
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

  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_order.status is distinct from p_expected_status then
    raise exception 'Order status changed' using errcode = 'PT409';
  end if;

  v_from := v_order.status;
  v_prev := v_order.driver_id;
  select s.step into v_step from public.order_statuses s
  where s.tenant_id = v_tenant_id and s.key = v_from;
  if v_step not in ('created', 'confirmed', 'accepted', 'delivery_failed') then
    raise exception 'Cannot assign an order in step %', v_step using errcode = '22023';
  end if;

  if p_delivery_date is null or p_driver_id is null then
    raise exception 'Driver and delivery date are required' using errcode = '22004';
  end if;
  if char_length(v_window) > 100 then
    raise exception 'Delivery window too long' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.users u
    join auth.users a on a.id = u.id
    where u.id = p_driver_id and u.tenant_id = v_tenant_id and u.role = 'driver'
      and (a.banned_until is null or a.banned_until <= now())
  ) then
    raise exception 'Driver not found or inactive' using errcode = '22023';
  end if;

  update public.orders
  set status = public.order_status_for_step(v_tenant_id, 'confirmed'),
      driver_id = p_driver_id,
      delivery_date = p_delivery_date,
      delivery_window = v_window,
      status_changed_at = now()
  where id = v_order.id
  returning * into v_order;

  perform public.log_order_event(v_order, 'assign', v_from, null, null, jsonb_build_object(
    'driver_id', p_driver_id,
    'delivery_date', p_delivery_date,
    'delivery_window', v_window,
    'previous_driver_id', v_prev
  ));
  return v_order;
end;
$$;

create or replace function public.cancel_order(
  p_order_id uuid,
  p_reason text,
  p_note text,
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
  v_note text := nullif(btrim(p_note), '');
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

  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_order.status is distinct from p_expected_status then
    raise exception 'Order status changed' using errcode = 'PT409';
  end if;

  v_from := v_order.status;
  select s.step into v_step from public.order_statuses s
  where s.tenant_id = v_tenant_id and s.key = v_from;
  if v_step not in ('created', 'confirmed', 'accepted', 'delivery_failed') then
    raise exception 'Cannot cancel an order in step %', v_step using errcode = '22023';
  end if;

  if p_reason is null or p_reason not in ('customer_closed', 'customer_refused', 'wrong_address', 'other') then
    raise exception 'Invalid cancel reason' using errcode = '22023';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'A note is required when the reason is other' using errcode = '22004';
  end if;

  update public.orders
  set status = public.order_status_for_step(v_tenant_id, 'cancelled'),
      status_changed_at = now()
  where id = v_order.id
  returning * into v_order;

  perform public.log_order_event(v_order, 'cancel', v_from, p_reason, v_note, null);
  return v_order;
end;
$$;

create or replace function public.correct_order_status(
  p_order_id uuid,
  p_status text,
  p_reason text,
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
  v_from_cat text;
  v_to_cat text;
  v_reason text := nullif(btrim(p_reason), '');
  v_invoice text;
  v_payload jsonb := '{}'::jsonb;
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

  if public.role() is distinct from 'admin' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_order.status is distinct from p_expected_status then
    raise exception 'Order status changed' using errcode = 'PT409';
  end if;

  if v_reason is null then
    raise exception 'A reason is required' using errcode = '22004';
  end if;

  v_to_cat := public.order_category(v_tenant_id, p_status);
  if v_to_cat is null or p_status = v_order.status then
    raise exception 'Invalid target status' using errcode = '22023';
  end if;

  v_from := v_order.status;
  v_from_cat := public.order_category(v_tenant_id, v_from);
  v_invoice := v_order.invoice_status;

  if v_from_cat = 'delivered' and v_to_cat <> 'delivered' then
    if v_invoice = 'issued' then
      raise exception 'The invoice was already issued' using errcode = '22023';
    elsif v_invoice = 'pending' then
      v_invoice := 'not_invoiced';
    end if;
  elsif v_to_cat = 'delivered' and v_from_cat <> 'delivered' then
    -- Task 5 must refine this once order_deliveries exists: only a correction
    -- with no recorded delivery should be marked without_signature.
    v_payload := jsonb_build_object('without_signature', true);
    v_invoice := 'pending';
  end if;

  update public.orders
  set status = p_status, invoice_status = v_invoice, status_changed_at = now()
  where id = v_order.id
  returning * into v_order;

  perform public.log_order_event(v_order, 'correct', v_from, v_reason, null, v_payload);
  return v_order;
end;
$$;

create or replace function public.list_tenant_drivers()
returns table (id uuid, name text, active boolean)
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
  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select u.id, u.name, (a.banned_until is null or a.banned_until <= now())
    from public.users u
    join auth.users a on a.id = u.id
    where u.tenant_id = v_tenant_id and u.role = 'driver'
    order by u.name;
end;
$$;

revoke execute on function public.assign_order(uuid, uuid, date, text, text) from public, anon;
revoke execute on function public.cancel_order(uuid, text, text, text) from public, anon;
revoke execute on function public.correct_order_status(uuid, text, text, text) from public, anon;
revoke execute on function public.list_tenant_drivers() from public, anon;
grant execute on function public.assign_order(uuid, uuid, date, text, text) to authenticated;
grant execute on function public.cancel_order(uuid, text, text, text) to authenticated;
grant execute on function public.correct_order_status(uuid, text, text, text) to authenticated;
grant execute on function public.list_tenant_drivers() to authenticated;
