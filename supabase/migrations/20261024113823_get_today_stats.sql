-- S5a of slice 5 (stats dashboard): get_today_stats() RPC.
--
-- Eng-review Decision 2 (REVISED after outside voice): explicit
-- admin-only check, not UI-only gating. CLAUDE.md's role-visibility
-- table marks "Estadísticas de ventas, ingresos, márgenes" as one of
-- only two rows where operator = No — the documented EXCEPTION to this
-- project's usual operator=admin trust level at the RLS layer, not an
-- instance of it. Without this check, any operator with a valid session
-- token could call this RPC directly and see real sales figures.

create or replace function public.get_today_stats(
  p_day_start timestamptz,
  p_day_end timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_orders_today int;
  v_pending_today int;
  v_delivered_today int;
  v_sales_today numeric;
  v_unpriced_count int;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- `is distinct from`, not `!=` — a null role() (shouldn't happen once
  -- tenant_id() is non-null, but cheap to guard) must still be rejected.
  -- Plain `!=` against NULL evaluates to NULL, and plpgsql's `if` treats
  -- NULL as false — i.e. it would silently skip the raise, the exact
  -- "looks authorized when it isn't" failure mode this check exists to
  -- prevent in the first place.
  if public.role() is distinct from 'admin' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select
    count(*),
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'delivered')
  into v_orders_today, v_pending_today, v_delivered_today
  from public.orders
  where tenant_id = v_tenant_id
    and created_at >= p_day_start
    and created_at < p_day_end;

  select
    coalesce(sum(oi.price_at_order * oi.quantity) filter (where oi.price_at_order is not null), 0),
    count(*) filter (where oi.price_at_order is null)
  into v_sales_today, v_unpriced_count
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.tenant_id = v_tenant_id
    and o.created_at >= p_day_start
    and o.created_at < p_day_end;

  return jsonb_build_object(
    'orders_today', v_orders_today,
    'pending_today', v_pending_today,
    'delivered_today', v_delivered_today,
    'sales_today', v_sales_today,
    'unpriced_count', v_unpriced_count
  );
end;
$$;

revoke all on function public.get_today_stats(timestamptz, timestamptz) from public;
grant execute on function public.get_today_stats(timestamptz, timestamptz) to authenticated;
