-- S4a of slice 4 (order detail dialog): order_items gains an audit trail
-- for price overrides, and a new update_order_detail() RPC is the single
-- atomic write path for the dialog's "notas + precio" edits.
--
-- Eng-review Decision 10 (revised mid-session — audit trail built now,
-- not deferred): price_overridden_by/at are null for a fresh order
-- (create_order()'s initial snapshot is not an "override"), and only get
-- set for the specific line(s) a later update_order_detail() call touches.

alter table public.order_items
  add column price_overridden_by uuid references public.users(id) on delete set null,
  add column price_overridden_at timestamptz;

-- ============================================================
-- update_order_detail(): atomic notes + per-line price edit
-- ============================================================
-- Decision 3: one RPC, not N independent REST calls — the real reason
-- isn't "atomicity" (any single RPC call is trivially atomic regardless),
-- it's that cross-order ownership validation (Decision 13) has to happen
-- before ANY write, which only a single server-side function can do.
create or replace function public.update_order_detail(
  p_order_id uuid,
  p_notes text,
  p_price_updates jsonb
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
  v_update jsonb;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Decision 4 (RLS silent-no-op risk): orders/order_items RLS already
  -- gates UPDATE on is_operator_or_admin(), but a plpgsql UPDATE that RLS
  -- filters to zero rows does NOT raise — it just returns having changed
  -- nothing. Checking the role explicitly here means a blocked caller
  -- (e.g. driver) gets a real error instead of a false "it worked".
  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Decision 12 (outside voice): a stale or cross-tenant p_order_id would
  -- otherwise hit the exact same silent-no-op failure mode Decision 4
  -- guards against, just from a different cause.
  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.tenant_id = v_tenant_id
  ) then
    raise exception 'Order not found for this tenant' using errcode = 'P0002';
  end if;

  if p_price_updates is null or jsonb_typeof(p_price_updates) != 'array' then
    raise exception 'price_updates must be an array' using errcode = '22004';
  end if;

  -- Decision 13 (outside voice): validate every order_item_id belongs to
  -- THIS order before writing anything — same defense-in-depth class
  -- create_order() already pays for on customer_id/product_id. Without
  -- this, a crafted request could reprice a line on a different order.
  for v_update in select * from jsonb_array_elements(p_price_updates)
  loop
    if not (v_update ? 'order_item_id') or not (v_update ? 'price_at_order') then
      raise exception 'Each price update needs order_item_id and price_at_order' using errcode = '22004';
    end if;

    if (v_update->>'price_at_order')::numeric <= 0 then
      raise exception 'price_at_order must be greater than zero' using errcode = '22003';
    end if;

    if not exists (
      select 1 from public.order_items oi
      where oi.id = (v_update->>'order_item_id')::uuid
        and oi.order_id = p_order_id
    ) then
      raise exception 'order_item % does not belong to this order', v_update->>'order_item_id'
        using errcode = 'P0002';
    end if;
  end loop;

  -- Decision 3: notes normalized the same way create_order()/slice 2
  -- already do — blank/whitespace-only collapses to a true NULL.
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  update public.orders
  set notes = v_notes
  where id = p_order_id
  returning * into v_order;

  for v_update in select * from jsonb_array_elements(p_price_updates)
  loop
    update public.order_items
    set price_at_order = (v_update->>'price_at_order')::numeric,
        price_overridden_by = auth.uid(),
        price_overridden_at = now()
    where id = (v_update->>'order_item_id')::uuid
      and order_id = p_order_id;
  end loop;

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', (
      select coalesce(jsonb_agg(to_jsonb(oi)), '[]'::jsonb)
      from public.order_items oi
      where oi.order_id = p_order_id
    )
  );
end;
$$;

revoke all on function public.update_order_detail(uuid, text, jsonb) from public;
grant execute on function public.update_order_detail(uuid, text, jsonb) to authenticated;
