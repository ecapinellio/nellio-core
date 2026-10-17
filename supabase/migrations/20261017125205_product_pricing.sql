-- Slice 1 of 5 (product pricing block): price_per_unit + unit on products.
-- Schema + RPC only — no UI this session (see the eng-review plan,
-- ~/.gstack/projects/ecapinellio-nellio-core/
-- emiliocarbonell-main-eng-review-plan-20261017-slice1-product-pricing.md).
-- Both columns stay nullable for now: the capture screen (T5) still calls
-- quick_add_product with only a name, and making these mandatory here would
-- break that screen until the next slice builds the UI that collects them.

-- ============================================================
-- Columns
-- ============================================================

alter table public.products
  add column price_per_unit numeric(10, 2),
  add column unit text;

-- Decision 9: table-level check, not just procedural validation in the RPC —
-- products' RLS policies gate tenant+role access, not values, so without
-- this a direct `update` via PostgREST could set a negative price and
-- bypass quick_add_product's own validation entirely.
alter table public.products
  add constraint products_price_per_unit_check
    check (price_per_unit is null or price_per_unit > 0);

-- Decision 2/3: check constraint over a fixed list, mirroring orders.status's
-- existing pattern — weight and volume units, since products are sold both
-- ways (e.g. the "Cloro 5L" test product is liquid, sold by volume).
-- `each` (not `unit`): `unit = 'unit'` would be a confusing self-reference
-- given the column is itself named `unit`.
alter table public.products
  add constraint products_unit_check
    check (unit is null or unit in ('ton', 'kg', 'lb', 'l', 'gal', 'each'));

-- ============================================================
-- quick_add_product(): extend with optional price/unit
-- ============================================================
-- Different signature than the existing function, so `create or replace`
-- alone would leave both overloads in the catalog — drop the old one first.
drop function if exists public.quick_add_product(text);

create or replace function public.quick_add_product(
  p_name text,
  p_price_per_unit numeric default null,
  p_unit text default null
)
returns public.products
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_product public.products;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required' using errcode = '22004';
  end if;

  -- Procedural check for a clean RPC-level error message — the table
  -- constraint above is the real guarantee, this just avoids surfacing a
  -- raw constraint-violation error to the caller (same defense-in-depth
  -- pattern create_order() already uses elsewhere).
  if p_price_per_unit is not null and p_price_per_unit <= 0 then
    raise exception 'price_per_unit must be greater than zero' using errcode = '22003';
  end if;

  insert into public.products (tenant_id, name, price_per_unit, unit)
  values (v_tenant_id, btrim(p_name), p_price_per_unit, p_unit)
  returning * into v_product;

  return v_product;
end;
$$;

revoke all on function public.quick_add_product(text, numeric, text) from public;
grant execute on function public.quick_add_product(text, numeric, text) to authenticated;
