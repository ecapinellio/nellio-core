-- S3a of slice 3 (kanban): real, immutable price snapshot on order_items.
-- Eng-review Decision 2 — the kanban card's price must be the price AT THE
-- TIME the order was created, not a live recomputation against today's
-- products.price_per_unit (which can drift after the order exists). Nullable:
-- orders created before this migration, or for a still-unpriced product,
-- render "Sin precio" instead of a fabricated number.

alter table public.order_items
  add column price_at_order numeric(10, 2),
  add column unit_at_order text;

-- Same table-level defense-in-depth pattern as products' own price/unit
-- columns (20261017125205_product_pricing.sql, Decision 9) — RLS gates
-- tenant+role access, not values, so a direct update bypassing create_order()
-- could otherwise write a negative price or an out-of-list unit.
alter table public.order_items
  add constraint order_items_price_at_order_check
    check (price_at_order is null or price_at_order > 0);

alter table public.order_items
  add constraint order_items_unit_at_order_check
    check (unit_at_order is null or unit_at_order in ('ton', 'kg', 'lb', 'l', 'gal', 'each'));

-- create_order(): populate the snapshot per line from the product's CURRENT
-- price/unit at insert time. Everything else in this function is unchanged
-- from 20261017142245_optional_notes.sql.
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
  v_product public.products;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_customer_id is null then
    raise exception 'customer_id is required' using errcode = '22004';
  end if;

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
    select * into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid;

    insert into public.order_items (order_id, product_id, quantity, price_at_order, unit_at_order)
    values (
      v_order.id,
      (v_item->>'product_id')::uuid,
      (v_item->>'quantity')::numeric,
      v_product.price_per_unit,
      v_product.unit
    );
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
