-- Security audit run-1 follow-up (2026-11-03). Three integrity gaps a tenant
-- operator could open by writing the tables directly through PostgREST
-- instead of going through the RPCs (REPORT.md §3):
--
-- 1. NaN passed every "> 0" check: Postgres numeric sorts NaN above every
--    number, so `x > 0` is true for it. One NaN line turned the admin's
--    get_today_stats() sales into "NaN", and a NaN product price was copied
--    into every new order line. The table checks now exclude it, which
--    covers the direct path and every RPC (create_order, update_order_detail,
--    quick_add_product) at once.
--
-- 2. orders.created_at / order_items.created_at were client-writable: an
--    operator could backdate an order out of the admin's daily stats. They
--    are now server-owned for tenant sessions, in the same triggers that
--    already own created_by and the price-override stamp.
--
-- 3. The price-override stamp only looked at price changes on UPDATE: a line
--    inserted directly at any price, or a product_id/unit swap, looked like
--    an untouched catalog snapshot. Now a line whose price/unit differ from
--    its product's catalog price/unit (on insert, or when product_id/unit
--    change) is stamped with the acting user. create_order() copies the
--    catalog values, so its lines stay unstamped. An existing stamp is never
--    erased.
--
-- Same escape as 20261103200000: no auth.uid() (service_role scripts,
-- fixtures) or a nested trigger (on delete set null) keeps what was written.

-- ============================================================
-- 1. NaN
-- ============================================================
alter table public.order_items
  drop constraint order_items_price_at_order_check,
  add constraint order_items_price_at_order_check
    check (price_at_order is null or (price_at_order > 0 and price_at_order <> 'NaN'::numeric));

alter table public.order_items
  drop constraint order_items_quantity_check,
  add constraint order_items_quantity_check
    check (quantity > 0 and quantity <> 'NaN'::numeric);

alter table public.products
  drop constraint products_price_per_unit_check,
  add constraint products_price_per_unit_check
    check (price_per_unit is null or (price_per_unit > 0 and price_per_unit <> 'NaN'::numeric));

-- ============================================================
-- 2. orders: created_by and created_at are server-owned
-- ============================================================
create or replace function public.stamp_order_created_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 2 + 3. order_items: created_at and the price-override stamp
-- ============================================================
create or replace function public.stamp_price_override()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_price numeric;
  v_unit text;
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    -- invoker: RLS shows only the caller's own products, and the composite
    -- FK already rejects a foreign product_id.
    select p.price_per_unit, p.unit into v_price, v_unit
    from public.products p
    where p.id = new.product_id;

    if new.price_at_order is not distinct from v_price and new.unit_at_order is not distinct from v_unit then
      new.price_overridden_by := null;
      new.price_overridden_at := null;
    else
      new.price_overridden_by := auth.uid();
      new.price_overridden_at := now();
    end if;
    return new;
  end if;

  new.created_at := old.created_at;

  if new.price_at_order is distinct from old.price_at_order
    or new.unit_at_order is distinct from old.unit_at_order then
    new.price_overridden_by := auth.uid();
    new.price_overridden_at := now();
  elsif new.product_id is distinct from old.product_id then
    select p.price_per_unit, p.unit into v_price, v_unit
    from public.products p
    where p.id = new.product_id;

    if new.price_at_order is distinct from v_price or new.unit_at_order is distinct from v_unit then
      new.price_overridden_by := auth.uid();
      new.price_overridden_at := now();
    else
      new.price_overridden_by := old.price_overridden_by;
      new.price_overridden_at := old.price_overridden_at;
    end if;
  else
    new.price_overridden_by := old.price_overridden_by;
    new.price_overridden_at := old.price_overridden_at;
  end if;

  return new;
end;
$$;
