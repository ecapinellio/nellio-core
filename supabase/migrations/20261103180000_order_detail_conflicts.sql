-- Order detail: no lost updates between two people editing the same order.
-- The panel used to send its notes on every save, so changing a price wiped
-- a colleague's new notes. Now it sends only what it changed, with the value
-- it loaded, and the save is rejected if that value moved (TODOS.md P2).

-- New 4th parameter; the 3-argument version is dropped so PostgREST has one
-- function to call. The app deployed before this migration still works: it
-- doesn't send p_expected, which keeps the old contract.
drop function public.update_order_detail(uuid, text, jsonb);

-- p_expected (null = old contract: notes always written, nothing checked):
--   - has key 'notes': write p_notes, but only if the stored notes still equal
--     p_expected->>'notes'.
--   - no key 'notes': leave the notes alone.
-- Each p_price_updates element may carry 'expected_price_at_order' (null =
-- "had no price"): that line is only repriced if it still holds that price.
-- Any mismatch raises PT409 (HTTP 409; 40001 would make PostgREST retry) before anything is written. A status move is not
-- a conflict: status isn't part of what this panel edits.
create or replace function public.update_order_detail(
  p_order_id uuid,
  p_notes text,
  p_price_updates jsonb,
  p_expected jsonb default null
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
  v_current_price numeric;
  v_write_notes boolean;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Explicit, not left to RLS (learning: plpgsql-update-silent-noop-under-rls).
  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_price_updates is null or jsonb_typeof(p_price_updates) != 'array' then
    raise exception 'price_updates must be an array' using errcode = '22004';
  end if;

  if p_expected is not null and jsonb_typeof(p_expected) != 'object' then
    raise exception 'expected must be an object' using errcode = '22004';
  end if;

  -- Lock the order, then its lines in id order: a concurrent save of the
  -- same order waits here and then sees the values this one wrote.
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.tenant_id = v_tenant_id
  for update;

  if not found then
    raise exception 'Order not found for this tenant' using errcode = 'P0002';
  end if;

  perform 1
  from public.order_items oi
  where oi.order_id = p_order_id
  order by oi.id
  for update;

  v_write_notes := p_expected is null or p_expected ? 'notes';

  if p_expected ? 'notes' and v_order.notes is distinct from (p_expected->>'notes') then
    raise exception 'Notes changed since the order was opened' using errcode = 'PT409';
  end if;

  -- Validate every line before writing anything: it belongs to this order
  -- (cross-order tampering guard), the price is positive, and it still holds
  -- the price the panel loaded.
  for v_update in select * from jsonb_array_elements(p_price_updates)
  loop
    if not (v_update ? 'order_item_id') or not (v_update ? 'price_at_order') then
      raise exception 'Each price update needs order_item_id and price_at_order' using errcode = '22004';
    end if;

    if (v_update->>'price_at_order')::numeric <= 0 then
      raise exception 'price_at_order must be greater than zero' using errcode = '22003';
    end if;

    select oi.price_at_order into v_current_price
    from public.order_items oi
    where oi.id = (v_update->>'order_item_id')::uuid
      and oi.order_id = p_order_id;

    if not found then
      raise exception 'order_item % does not belong to this order', v_update->>'order_item_id'
        using errcode = 'P0002';
    end if;

    if v_update ? 'expected_price_at_order'
      and v_current_price is distinct from (v_update->>'expected_price_at_order')::numeric then
      raise exception 'A price changed since the order was opened' using errcode = 'PT409';
    end if;
  end loop;

  if v_write_notes then
    -- Normalized like create_order(): blank collapses to a true NULL.
    v_notes := nullif(btrim(coalesce(p_notes, '')), '');
    update public.orders
    set notes = v_notes
    where id = p_order_id
    returning * into v_order;
  end if;

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

revoke all on function public.update_order_detail(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.update_order_detail(uuid, text, jsonb, jsonb) to authenticated;
