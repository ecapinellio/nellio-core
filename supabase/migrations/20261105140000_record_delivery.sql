-- Delivery with proof (signature, receiver, photo, payment), partial and failed.
-- The phone generates order_deliveries.id so a retry after a timeout is idempotent.

-- ============================================================
-- order_deliveries
-- ============================================================
create table public.order_deliveries (
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  driver_id uuid references public.users (id) on delete set null,
  outcome text not null check (outcome in ('delivered', 'partially_delivered', 'failed')),
  receiver_name text check (char_length(receiver_name) <= 200),
  signature_path text,
  photo_path text,
  failure_reason text check (failure_reason in ('customer_closed', 'customer_refused', 'wrong_address', 'other')),
  failure_note text check (char_length(failure_note) <= 200),
  payment_method text check (payment_method in ('cash', 'check', 'transfer', 'credit')),
  amount_collected numeric(10, 2) check (amount_collected >= 0 and amount_collected <> 'NaN'::numeric),
  created_at timestamptz not null default now()
);
create index order_deliveries_order_idx on public.order_deliveries (tenant_id, order_id);

alter table public.order_deliveries enable row level security;
create policy order_deliveries_select on public.order_deliveries
  for select to authenticated
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
-- Only record_delivery() writes.
revoke all on public.order_deliveries from anon, authenticated;
grant select on public.order_deliveries to authenticated;

-- ============================================================
-- Storage: private bucket for signatures and photos
-- Paths: {tenant_id}/{delivery_id}/signature.png | photo.jpg
-- ============================================================
insert into storage.buckets (id, name, public) values ('delivery-proofs', 'delivery-proofs', false)
on conflict do nothing;

create policy delivery_proofs_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'delivery-proofs'
    and (select public.role()) = 'driver'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
  );

create policy delivery_proofs_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'delivery-proofs'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
    and (
      (select public.is_operator_or_admin())
      or ((select public.role()) = 'driver' and owner = (select auth.uid()))
    )
  );
-- No update or delete policies: proofs are immutable.

-- ============================================================
-- record_delivery
-- ============================================================
create or replace function public.record_delivery(
  p_delivery_id uuid,
  p_order_id uuid,
  p_outcome text,
  p_lines jsonb,
  p_receiver_name text,
  p_signature_path text,
  p_photo_path text,
  p_failure_reason text,
  p_failure_note text,
  p_payment_method text,
  p_amount_collected numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_order public.orders;
  v_delivery public.order_deliveries;
  v_from text;
  v_step text;
  v_receiver text := nullif(btrim(p_receiver_name), '');
  v_note text := nullif(btrim(p_failure_note), '');
  v_prefix text;
  v_path text;
  v_req_sig boolean;
  v_req_name boolean;
  v_req_photo boolean;
  v_line jsonb;
  v_item public.order_items;
  v_qty numeric;
  v_reason text;
  v_seen uuid[] := '{}';
  v_item_count int;
  v_any_pos boolean := false;
  v_partial boolean := false;
  v_outcome text;
  v_to_step text;
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_delivery_id is null or p_order_id is null then
    raise exception 'Delivery and order ids are required' using errcode = '22004';
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

  -- Retry: before the step check, because the order may have left picked_up
  -- because of this very delivery. A foreign row is never revealed.
  select * into v_delivery from public.order_deliveries d where d.id = p_delivery_id;
  if found then
    if v_delivery.order_id is distinct from p_order_id or v_delivery.driver_id is distinct from auth.uid() then
      raise exception 'Invalid delivery id' using errcode = '22023';
    end if;
    return jsonb_build_object('order', to_jsonb(v_order), 'delivery', to_jsonb(v_delivery));
  end if;

  v_from := v_order.status;
  select s.step into v_step from public.order_statuses s
  where s.tenant_id = v_tenant_id and s.key = v_from;
  if v_step is null or v_step not in ('picked_up') then
    raise exception 'Cannot record a delivery for an order in step %', v_step using errcode = '22023';
  end if;

  if p_outcome is null or p_outcome not in ('delivered', 'failed') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;

  if p_payment_method is not null and p_payment_method not in ('cash', 'check', 'transfer', 'credit') then
    raise exception 'Invalid payment method' using errcode = '22023';
  end if;
  if p_amount_collected is not null and (
       p_amount_collected < 0 or p_amount_collected = 'NaN'::numeric
       or p_amount_collected >= 100000000
       or p_payment_method is null or p_payment_method = 'credit') then
    raise exception 'Invalid amount collected' using errcode = '22023';
  end if;
  if char_length(v_receiver) > 200 or char_length(v_note) > 200 then
    raise exception 'Text too long' using errcode = '22023';
  end if;

  if p_outcome = 'failed' then
    if p_failure_reason is null then
      raise exception 'A failure reason is required' using errcode = '22004';
    end if;
    if p_failure_reason not in ('customer_closed', 'customer_refused', 'wrong_address', 'other') then
      raise exception 'Invalid failure reason' using errcode = '22023';
    end if;
    if p_failure_reason = 'other' and v_note is null then
      raise exception 'A note is required when the reason is other' using errcode = '22004';
    end if;
    if p_payment_method is not null or p_amount_collected is not null then
      raise exception 'A failed delivery has no payment' using errcode = '22023';
    end if;

    insert into public.order_deliveries (id, tenant_id, order_id, driver_id, outcome, failure_reason, failure_note)
    values (p_delivery_id, v_tenant_id, v_order.id, auth.uid(), 'failed', p_failure_reason, v_note)
    returning * into v_delivery;

    update public.orders
    set status = public.order_status_for_step(v_tenant_id, 'delivery_failed'), status_changed_at = now()
    where id = v_order.id
    returning * into v_order;
    perform public.log_order_event(v_order, 'fail', v_from, p_failure_reason, v_note,
      jsonb_build_object('delivery_id', p_delivery_id));
    return jsonb_build_object('order', to_jsonb(v_order), 'delivery', to_jsonb(v_delivery));
  end if;

  -- Delivered (fully or partially)
  select coalesce(t.require_signature, true), coalesce(t.require_receiver_name, true), coalesce(t.require_photo, false)
  into v_req_sig, v_req_name, v_req_photo
  from (select 1) x left join public.tenant_order_settings t on t.tenant_id = v_tenant_id;

  if v_req_name and v_receiver is null then
    raise exception 'Receiver name is required' using errcode = '22004';
  end if;
  if v_req_sig and p_signature_path is null then
    raise exception 'Signature is required' using errcode = '22004';
  end if;
  if v_req_photo and p_photo_path is null then
    raise exception 'Photo is required' using errcode = '22004';
  end if;

  -- Proof paths: exactly {tenant}/{delivery}/..., and the object must exist.
  v_prefix := v_tenant_id::text || '/' || p_delivery_id::text || '/';
  foreach v_path in array array[p_signature_path, p_photo_path]
  loop
    if v_path is not null and (
         left(v_path, char_length(v_prefix)) <> v_prefix
         or char_length(v_path) = char_length(v_prefix)
         or v_path like '%..%'
         or not exists (select 1 from storage.objects so where so.bucket_id = 'delivery-proofs' and so.name = v_path)
       ) then
      raise exception 'Invalid proof path' using errcode = '22023';
    end if;
  end loop;

  if p_lines is null or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Lines must be an array' using errcode = '22023';
  end if;
  select count(*) into v_item_count from public.order_items i where i.order_id = v_order.id;
  if jsonb_array_length(p_lines) <> v_item_count then
    raise exception 'Every order line is required' using errcode = '22023';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    -- is distinct from: a missing key gives NULL typeof, and NULL <> 'x' would skip the check.
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line -> 'order_item_id') is distinct from 'string'
       or jsonb_typeof(v_line -> 'delivered_quantity') is distinct from 'number'
       or (v_line ->> 'order_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid line' using errcode = '22023';
    end if;
    select * into v_item from public.order_items i
    where i.id = (v_line ->> 'order_item_id')::uuid and i.order_id = v_order.id;
    if not found or v_item.id = any (v_seen) then
      raise exception 'Invalid line' using errcode = '22023';
    end if;
    v_seen := v_seen || v_item.id;

    v_qty := (v_line ->> 'delivered_quantity')::numeric;
    if v_qty < 0 or v_qty > v_item.quantity or v_qty <> round(v_qty, 2) then
      raise exception 'Invalid delivered quantity' using errcode = '22023';
    end if;
    if v_qty > 0 then v_any_pos := true; end if;

    if v_qty < v_item.quantity then
      v_partial := true;
      v_reason := v_line ->> 'reason';
      if v_reason is null or v_reason not in ('refused', 'damaged', 'short', 'other') then
        raise exception 'A valid shortfall reason is required' using errcode = '22023';
      end if;
      if char_length(v_line ->> 'note') > 200 then
        raise exception 'Text too long' using errcode = '22023';
      end if;
      update public.order_items
      set delivered_quantity = v_qty, shortfall_reason = v_reason, shortfall_note = nullif(btrim(v_line ->> 'note'), '')
      where id = v_item.id;
    else
      update public.order_items
      set delivered_quantity = v_qty, shortfall_reason = null, shortfall_note = null
      where id = v_item.id;
    end if;
  end loop;

  if not v_any_pos then
    raise exception 'Nothing was delivered: use failed delivery' using errcode = '22023';
  end if;

  v_outcome := case when v_partial then 'partially_delivered' else 'delivered' end;
  v_to_step := v_outcome;

  insert into public.order_deliveries (id, tenant_id, order_id, driver_id, outcome, receiver_name,
                                       signature_path, photo_path, payment_method, amount_collected)
  values (p_delivery_id, v_tenant_id, v_order.id, auth.uid(), v_outcome, v_receiver,
          p_signature_path, p_photo_path, p_payment_method, p_amount_collected)
  returning * into v_delivery;

  update public.orders
  set status = public.order_status_for_step(v_tenant_id, v_to_step),
      invoice_status = 'pending', status_changed_at = now()
  where id = v_order.id
  returning * into v_order;
  perform public.log_order_event(v_order, 'deliver', v_from, null, null,
    jsonb_build_object('delivery_id', p_delivery_id, 'partial', v_partial));

  return jsonb_build_object('order', to_jsonb(v_order), 'delivery', to_jsonb(v_delivery));
end;
$$;

revoke execute on function public.record_delivery(uuid, uuid, text, jsonb, text, text, text, text, text, text, numeric)
  from public, anon;
grant execute on function public.record_delivery(uuid, uuid, text, jsonb, text, text, text, text, text, text, numeric)
  to authenticated;

-- ============================================================
-- correct_order_status: refine now that order_deliveries exists
-- ============================================================
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
    -- Marked without_signature only when no delivery with proof was recorded.
    if not exists (
      select 1 from public.order_deliveries d
      where d.order_id = v_order.id and d.outcome in ('delivered', 'partially_delivered')
    ) then
      v_payload := jsonb_build_object('without_signature', true);
    end if;
    -- Never overwrite 'issued' or 'error'.
    if v_invoice = 'not_invoiced' then
      v_invoice := 'pending';
    end if;
  end if;

  update public.orders
  set status = p_status, invoice_status = v_invoice, status_changed_at = now()
  where id = v_order.id
  returning * into v_order;

  perform public.log_order_event(v_order, 'correct', v_from, v_reason, null, v_payload);
  return v_order;
end;
$$;
