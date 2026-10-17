-- Slice 2 of the product-pricing/capture-redesign block: orders.notes
-- becomes optional. NULL means "nothing was written" — an empty string
-- would be ambiguous (written then cleared, vs. never touched), which
-- matters for any future reporting on how many orders arrive with no
-- original WhatsApp message (Decision 3 of the eng-review plan).

alter table public.orders
  alter column notes drop not null;

-- Same signature as before (p_notes text was already nullable at the
-- parameter level — only the column had the NOT NULL constraint), so
-- create or replace is enough, no need to drop first.
create or replace function public.create_order(
  p_customer_id uuid,
  p_notes text,
  p_items jsonb,
  p_channel text default 'whatsapp'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_notes text;
  v_order public.orders;
  v_item jsonb;
  v_item_count int;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_customer_id is null then
    raise exception 'customer_id is required' using errcode = '22004';
  end if;

  -- Decision 3: notes is now optional. Blank/whitespace-only input
  -- normalizes to a true NULL rather than being stored as '' or as
  -- untrimmed whitespace.
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  if p_items is null or jsonb_typeof(p_items) != 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one order item is required' using errcode = '22004';
  end if;

  -- SECURITY INVOKER means this select is itself RLS-scoped to the
  -- caller's tenant, so a cross-tenant customer_id is already invisible
  -- here. The explicit tenant_id filter is kept anyway as defense in
  -- depth — it must keep working even if the RLS policy set changes.
  if not exists (
    select 1 from public.customers c
    where c.id = p_customer_id and c.tenant_id = v_tenant_id
  ) then
    raise exception 'Customer not found for this tenant' using errcode = 'P0002';
  end if;

  -- Reject cross-tenant or malformed product references before writing
  -- anything, so a bad item in the array can't leave earlier items
  -- committed — the loop below re-walks the same validated array.
  v_item_count := 0;
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_item_count := v_item_count + 1;

    if not (v_item ? 'product_id') or not (v_item ? 'quantity') then
      raise exception 'Item % is missing product_id or quantity', v_item_count
        using errcode = '22004';
    end if;

    if not exists (
      select 1 from public.products p
      where p.id = (v_item->>'product_id')::uuid and p.tenant_id = v_tenant_id
    ) then
      raise exception 'Product not found for this tenant (item %)', v_item_count
        using errcode = 'P0002';
    end if;

    if (v_item->>'quantity')::numeric <= 0 then
      raise exception 'Item % quantity must be greater than zero', v_item_count
        using errcode = '22003';
    end if;
  end loop;

  -- RLS's WITH CHECK on orders (tenant_id = tenant_id()) and the
  -- order_items_set_tenant_id trigger provide defense in depth even
  -- though v_tenant_id is already trusted (server-derived, not
  -- client-supplied) at this point.
  insert into public.orders (tenant_id, customer_id, created_by, notes, channel)
  values (v_tenant_id, p_customer_id, auth.uid(), v_notes, coalesce(p_channel, 'whatsapp'))
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.order_items (order_id, product_id, quantity)
    values (v_order.id, (v_item->>'product_id')::uuid, (v_item->>'quantity')::numeric);
  end loop;

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', (
      select coalesce(jsonb_agg(to_jsonb(oi)), '[]'::jsonb)
      from public.order_items oi
      where oi.order_id = v_order.id
    )
  );
end;
$$;
