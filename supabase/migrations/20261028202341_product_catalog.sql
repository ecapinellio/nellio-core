-- Product catalog page (/products): soft-deactivation, duplicate guard,
-- last-editor tracking and the save_products() batch RPC. See the eng +
-- design review plan:
-- ~/.gstack/projects/ecapinellio-nellio-core/
-- emiliocarbonell-main-eng-review-plan-20261026-product-catalog.md

-- ============================================================
-- Columns
-- ============================================================

-- D3: retire a product without deleting it (order_items.product_id is
-- `on delete restrict`, and old orders must keep showing it).
alter table public.products
  add column active boolean not null default true;

-- D5: who made the last change, for the concurrent-edit notice. Set by the
-- trigger below, never by callers.
alter table public.products
  add column updated_by uuid references public.users (id) on delete set null;

-- ============================================================
-- Duplicate guard (D4 + outside voice #4, #10a)
-- ============================================================
-- One spec, mirrored by normalizeProductName() in lib/products/grid.ts:
-- lowercase, no accents, no whitespace at all — "Cloro 5%" = "CLORO 5 %".
--   covers the non-breaking spaces Excel likes to paste.
create or replace function public.normalize_product_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(public.immutable_unaccent(p_name), '[[:space:] ]+', '', 'g'))
$$;

-- Abort with a readable list instead of a bare "could not create unique
-- index" if a tenant already has near-duplicates (e.g. capture-era quick-adds).
do $$
declare
  v_dupes text;
begin
  select string_agg(format('tenant %s: %s', tenant_id, names), E'\n')
  into v_dupes
  from (
    select tenant_id, string_agg(name, ' | ' order by name) as names
    from public.products
    group by tenant_id, public.normalize_product_name(name)
    having count(*) > 1
  ) d;

  if v_dupes is not null then
    raise exception E'Duplicate product names must be merged before this migration:\n%', v_dupes;
  end if;
end;
$$;

create unique index products_tenant_name_uniq
  on public.products (tenant_id, public.normalize_product_name(name));

-- ============================================================
-- Tenant-scoped foreign keys (/review finding)
-- ============================================================
-- A plain FK ignores RLS, so an operator inserting/updating directly through
-- PostgREST could point an order line at another tenant's product (or an
-- order at another tenant's customer) just by knowing its id. Composite FKs
-- make "same tenant" a constraint the database enforces on every path.
alter table public.products
  add constraint products_tenant_id_id_key unique (tenant_id, id);
alter table public.order_items
  drop constraint order_items_product_id_fkey,
  add constraint order_items_product_tenant_fkey
    foreign key (tenant_id, product_id) references public.products (tenant_id, id) on delete restrict;

alter table public.customers
  add constraint customers_tenant_id_id_key unique (tenant_id, id);
alter table public.orders
  drop constraint orders_customer_id_fkey,
  add constraint orders_customer_tenant_fkey
    foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete restrict;

-- ============================================================
-- Last editor (outside voice #2)
-- ============================================================
-- A trigger, not the RPCs: capture's updateProductPricing() PATCHes the
-- table directly, and the update policy allows any operator to do so.
create or replace function public.set_product_updated_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger products_set_updated_by
  before insert or update on public.products
  for each row execute function public.set_product_updated_by();

-- ============================================================
-- Inactive products can't be ordered (D3 + outside voice #3)
-- ============================================================
-- On order_items, not in create_order(): operators also have direct
-- insert/update policies on order_items (role_rbac.sql). security invoker
-- on purpose — a product outside the caller's tenant is invisible here, so
-- this never leaks another tenant's product name; the composite FK above
-- rejects a foreign product_id outright.
create or replace function public.reject_inactive_product()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_name text;
begin
  select p.name into v_name
  from public.products p
  where p.id = new.product_id and not p.active;

  if found then
    raise exception 'El producto "%" ya no está activo.', v_name using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger order_items_reject_inactive_product
  before insert or update of product_id on public.order_items
  for each row execute function public.reject_inactive_product();

-- ============================================================
-- search_products(): active only
-- ============================================================
create or replace function public.search_products(p_query text, p_limit int default 10)
returns setof public.products
language sql
stable
security invoker
set search_path = ''
as $$
  select p.*
  from public.products p
  where p.tenant_id = public.tenant_id()
    and p.active
    and (
      p_query is null or btrim(p_query) = ''
      or public.immutable_unaccent(p.name)
        OPERATOR(extensions.%) public.immutable_unaccent(p_query)
    )
  order by
    case when p_query is null or btrim(p_query) = '' then null
      else extensions.similarity(public.immutable_unaccent(p.name), public.immutable_unaccent(p_query))
    end desc nulls last,
    p.name asc
  limit greatest(p_limit, 0)
$$;

-- ============================================================
-- quick_add_product(): clean duplicate error
-- ============================================================
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

  if p_price_per_unit is not null and p_price_per_unit <= 0 then
    raise exception 'price_per_unit must be greater than zero' using errcode = '22003';
  end if;

  begin
    insert into public.products (tenant_id, name, price_per_unit, unit)
    values (v_tenant_id, btrim(p_name), p_price_per_unit, p_unit)
    returning * into v_product;
  exception when unique_violation then
    raise exception 'Ya existe un producto con ese nombre.' using errcode = '23505';
  end;

  return v_product;
end;
$$;

-- ============================================================
-- save_products(): the catalog grid's batch save
-- ============================================================
-- p_rows: [{id?, name, price_per_unit, unit, active, updated_at?}]
--   no id → insert (price + unit required)
--   id    → update; price/unit may stay null only if they already were
--           (a quick-added row can be renamed/deactivated without
--           inventing a price — outside voice #6)
--
--   validate all ──▶ foreign/unknown id? raise
--        │
--        ▼
--   any updated_at changed since the grid loaded? ──yes──▶ return conflicts, write nothing
--        │no
--        ▼
--   updates + inserts (one transaction) ──▶ {saved, conflicts: []}
--
-- updated_at comes back as the exact text Postgres sent (never through a JS
-- Date, which drops microseconds — outside voice #1).
--
-- Known edge (outside voice #5): swapping two names (A↔B) in one batch can
-- hit the unique index mid-statement and report "ya existe". Rare; save in
-- two steps.
create or replace function public.save_products(p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_row jsonb;
  v_id uuid;
  v_name text;
  v_price numeric;
  v_unit text;
  v_current public.products;
  v_conflicts jsonb := '[]'::jsonb;
  v_dupes text;
  v_saved int := 0;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Explicit, not left to RLS: an UPDATE that RLS filters out is a silent
  -- no-op inside a security invoker function (learning:
  -- plpgsql-update-silent-noop-under-rls).
  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) != 'array' then
    raise exception 'rows must be an array' using errcode = '22004';
  end if;

  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Máximo 1000 productos por guardado.' using errcode = '22023';
  end if;

  -- 1. Validate every row before touching anything.
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_id := nullif(v_row->>'id', '')::uuid;
    v_name := btrim(coalesce(v_row->>'name', ''));
    v_price := nullif(v_row->>'price_per_unit', '')::numeric;
    v_unit := nullif(v_row->>'unit', '');

    if v_name = '' then
      raise exception 'Falta el nombre de un producto.' using errcode = '22004';
    end if;

    if length(v_name) > 200 then
      raise exception 'El nombre "%" es demasiado largo.', left(v_name, 40) using errcode = '22001';
    end if;

    if v_price is not null and v_price <= 0 then
      raise exception 'El precio de "%" debe ser mayor que cero.', v_name using errcode = '22003';
    end if;

    -- numeric(10,2): reject instead of silently rounding or overflowing.
    if v_price is not null and (v_price > 99999999.99 or v_price <> round(v_price, 2)) then
      raise exception 'El precio de "%" no es válido (máximo 99,999,999.99 y 2 decimales).', v_name using errcode = '22003';
    end if;

    if v_unit is not null and v_unit not in ('ton', 'kg', 'lb', 'l', 'gal', 'each') then
      raise exception 'La unidad de "%" no es válida.', v_name using errcode = '22023';
    end if;

    if v_id is null then
      if v_price is null or v_unit is null then
        raise exception 'Falta el precio o la unidad de "%".', v_name using errcode = '22004';
      end if;
    else
      -- for update: a concurrent save of the same row waits here, then sees
      -- the new updated_at and reports a conflict instead of silently
      -- overwriting it (review: lost update between check and write).
      select * into v_current
      from public.products p
      where p.id = v_id and p.tenant_id = v_tenant_id
      for update;

      if not found then
        raise exception 'Producto no encontrado.' using errcode = 'P0002';
      end if;

      if (v_price is null and v_current.price_per_unit is not null)
        or (v_unit is null and v_current.unit is not null) then
        raise exception 'Falta el precio o la unidad de "%".', v_name using errcode = '22004';
      end if;

      -- 2. Conflict check: someone saved this row after the grid loaded it.
      if v_current.updated_at is distinct from nullif(v_row->>'updated_at', '')::timestamptz then
        v_conflicts := v_conflicts || jsonb_build_object(
          'id', v_current.id,
          'name', v_current.name,
          'price_per_unit', v_current.price_per_unit,
          'unit', v_current.unit,
          'active', v_current.active,
          'updated_at', v_current.updated_at,
          'updated_by_name', (select u.name from public.users u where u.id = v_current.updated_by)
        );
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('saved', 0, 'conflicts', v_conflicts);
  end if;

  -- 3. Readable duplicate check (the unique index stays the real guard):
  -- within the batch, and against catalog rows the batch doesn't touch.
  -- Normalize each row once and group — a per-row correlated count was
  -- O(n²) and blew the 8s statement timeout at 1000 rows.
  with batch as (
    select btrim(r->>'name') as name,
      public.normalize_product_name(r->>'name') as norm,
      nullif(r->>'id', '')::uuid as id
    from jsonb_array_elements(p_rows) r
  ),
  repeated as (
    select norm from batch group by norm having count(*) > 1
  )
  select string_agg(distinct b.name, ', ')
  into v_dupes
  from batch b
  where b.norm in (select norm from repeated)
    or exists (
      select 1 from public.products p
      where p.tenant_id = v_tenant_id
        and public.normalize_product_name(p.name) = b.norm
        and p.id is distinct from b.id
        and not exists (select 1 from batch b2 where b2.id = p.id)
    );

  if v_dupes is not null then
    raise exception 'Ya existe: %', v_dupes using errcode = '23505';
  end if;

  -- 4. Write. updated_by/updated_at come from triggers.
  begin
    for v_row in select * from jsonb_array_elements(p_rows)
    loop
      v_id := nullif(v_row->>'id', '')::uuid;
      v_name := btrim(v_row->>'name');
      v_price := nullif(v_row->>'price_per_unit', '')::numeric;
      v_unit := nullif(v_row->>'unit', '');

      if v_id is null then
        insert into public.products (tenant_id, name, price_per_unit, unit, active)
        values (v_tenant_id, v_name, v_price, v_unit, coalesce((v_row->>'active')::boolean, true));
      else
        update public.products
        set name = v_name,
            price_per_unit = v_price,
            unit = v_unit,
            active = coalesce((v_row->>'active')::boolean, active)
        where id = v_id and tenant_id = v_tenant_id;
      end if;

      v_saved := v_saved + 1;
    end loop;
  exception when unique_violation then
    raise exception 'Ya existe un producto con ese nombre.' using errcode = '23505';
  end;

  return jsonb_build_object('saved', v_saved, 'conflicts', '[]'::jsonb);
end;
$$;

revoke all on function public.save_products(jsonb) from public, anon;
grant execute on function public.save_products(jsonb) to authenticated;
revoke all on function public.normalize_product_name(text) from public, anon;
grant execute on function public.normalize_product_name(text) to authenticated;
