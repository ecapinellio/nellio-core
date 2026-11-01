-- /customers page + shared name normalizer (customers eng + design review,
-- ~/.gstack/projects/ecapinellio-nellio-core/
-- emiliocarbonell-main-eng-review-plan-20261101-customers.md).

-- ============================================================
-- normalize_product_name → normalize_name (D5)
-- ============================================================
-- One normalizer for every table with unique names. plpgsql bodies aren't
-- dependency-tracked, so save_products() is recreated below with the new
-- name before the old function is dropped (outside voice #1).
create or replace function public.normalize_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(public.immutable_unaccent(p_name), '[[:space:] ]+', '', 'g'))
$$;

drop index public.products_tenant_name_uniq;
create unique index products_tenant_name_uniq
  on public.products (tenant_id, public.normalize_name(name));

-- Recreated unchanged except for the normalizer's name.
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

  -- Lock every edited row up front in id order: locking in grid order let
  -- two concurrent saves grab the same rows in opposite orders and deadlock.
  perform 1
  from public.products p
  where p.tenant_id = v_tenant_id
    and p.id in (select nullif(r->>'id', '')::uuid from jsonb_array_elements(p_rows) r)
  order by p.id
  for update;

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
      public.normalize_name(r->>'name') as norm,
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
        and public.normalize_name(p.name) = b.norm
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

-- quick_add_product(): a name that exists but is deactivated (and so hidden
-- from capture search) says so, instead of a dead-end "ya existe" (outside voice #6).
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
    if exists (
      select 1 from public.products p
      where p.tenant_id = v_tenant_id
        and public.normalize_name(p.name) = public.normalize_name(p_name)
        and not p.active
    ) then
      raise exception 'Ya existe un producto desactivado con ese nombre. Reactívalo en Productos.' using errcode = '23505';
    end if;
    raise exception 'Ya existe un producto con ese nombre.' using errcode = '23505';
  end;

  return v_product;
end;
$$;

drop function public.normalize_product_name(text);
revoke all on function public.normalize_name(text) from public, anon;
grant execute on function public.normalize_name(text) to authenticated;

-- ============================================================
-- customers: active, updated_by, unique name
-- ============================================================
alter table public.customers
  add column active boolean not null default true,
  add column updated_by uuid references public.users (id) on delete set null;

-- Last editor, same trigger as products — renamed now that two tables use it.
create or replace function public.set_updated_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger products_set_updated_by on public.products;
create trigger products_set_updated_by
  before insert or update on public.products
  for each row execute function public.set_updated_by();
drop function public.set_product_updated_by();

create trigger customers_set_updated_by
  before insert or update on public.customers
  for each row execute function public.set_updated_by();

do $$
declare
  v_dupes text;
begin
  select string_agg(format('tenant %s: %s', tenant_id, names), E'\n')
  into v_dupes
  from (
    select tenant_id, string_agg(name, ' | ' order by name) as names
    from public.customers
    group by tenant_id, public.normalize_name(name)
    having count(*) > 1
  ) d;

  if v_dupes is not null then
    raise exception E'Duplicate customer names must be merged before this migration:\n%', v_dupes;
  end if;
end;
$$;

-- D8: branches get distinct names ("Super Selectos Escalón").
create unique index customers_tenant_name_uniq
  on public.customers (tenant_id, public.normalize_name(name));

-- ============================================================
-- Fiscal field formats (D6, outside voice #3), mirrored in lib/customers/parse.ts
-- ============================================================
-- NIT (14 digits) or DUI (9). Excel drops a leading zero from numeric cells,
-- so 13 and 8 digits get it back — 8 only when the DUI check digit matches,
-- since an 8-digit phone in the NIT column isn't a DUI. Returns the
-- canonical dashed form, or null if it isn't a NIT/DUI.
create or replace function public.normalize_tax_id(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with raw as (
    select regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') as d
  ),
  digits as (
    select case
      when length(d) = 13 then '0' || d
      when length(d) = 8 then
        case when (10 - (
            select sum(substr('0' || d, i, 1)::int * (10 - i)) from generate_series(1, 8) i
          ) % 10) % 10 = right(d, 1)::int
        then '0' || d end
      else d
    end as d
    from raw
  )
  select case length(d)
    when 14 then format('%s-%s-%s-%s', substr(d, 1, 4), substr(d, 5, 6), substr(d, 11, 3), substr(d, 14, 1))
    when 9 then format('%s-%s', substr(d, 1, 8), substr(d, 9, 1))
    else null
  end
  from digits
$$;

-- NRC: 2-8 digits, the last one a check digit → "123456-7".
create or replace function public.normalize_nrc(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when d ~ '^[0-9]{2,8}$' then left(d, length(d) - 1) || '-' || right(d, 1)
    else null
  end
  from (select regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') as d) raw
  where btrim(coalesce(p_value, '')) ~ '^[0-9][0-9 -]*$'
$$;

revoke all on function public.normalize_tax_id(text) from public, anon;
grant execute on function public.normalize_tax_id(text) to authenticated;
revoke all on function public.normalize_nrc(text) from public, anon;
grant execute on function public.normalize_nrc(text) to authenticated;

-- ============================================================
-- Inactive customers can't get new orders
-- ============================================================
-- Same reasoning as reject_inactive_product(): on the table, so direct
-- PostgREST writes are covered too; invoker so a foreign id leaks nothing.
create or replace function public.reject_inactive_customer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_name text;
begin
  select c.name into v_name
  from public.customers c
  where c.id = new.customer_id and not c.active;

  if found then
    raise exception 'El cliente "%" ya no está activo.', v_name using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger orders_reject_inactive_customer
  before insert or update of customer_id on public.orders
  for each row execute function public.reject_inactive_customer();

-- ============================================================
-- search_customers(): active only; also by phone / NIT digits (design D9)
-- ============================================================
-- Typing the WhatsApp sender's number (or a NIT) finds the customer.
create or replace function public.search_customers(p_query text, p_limit int default 10)
returns setof public.customers
language sql
stable
security invoker
set search_path = ''
as $$
  -- Digit matching only for number-like queries: "Ferretería 2000" is a
  -- name search, not phones containing 2000.
  with q as (
    select case when btrim(coalesce(p_query, '')) ~ '^[0-9 +().-]+$'
      then regexp_replace(p_query, '[^0-9]', '', 'g')
      else ''
    end as digits
  )
  select c.*
  from public.customers c, q
  where c.tenant_id = public.tenant_id()
    and c.active
    and (
      p_query is null or btrim(p_query) = ''
      or public.immutable_unaccent(c.name)
        OPERATOR(extensions.%) public.immutable_unaccent(p_query)
      or (
        length(q.digits) >= 4
        and (
          regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || q.digits || '%'
          or regexp_replace(coalesce(c.tax_id, ''), '[^0-9]', '', 'g') like '%' || q.digits || '%'
        )
      )
    )
  order by
    -- The WhatsApp sender's number is the strongest signal, then a NIT.
    case
      when length(q.digits) >= 4 and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || q.digits || '%' then 0
      when length(q.digits) >= 4 and regexp_replace(coalesce(c.tax_id, ''), '[^0-9]', '', 'g') like '%' || q.digits || '%' then 1
      else 2
    end,
    case when p_query is null or btrim(p_query) = '' then null
      else extensions.similarity(public.immutable_unaccent(c.name), public.immutable_unaccent(p_query))
    end desc nulls last,
    c.name asc
  limit greatest(p_limit, 0)
$$;

-- ============================================================
-- quick_add_customer(): clean duplicate / deactivated errors
-- ============================================================
create or replace function public.quick_add_customer(p_name text)
returns public.customers
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_customer public.customers;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required' using errcode = '22004';
  end if;

  begin
    insert into public.customers (tenant_id, name)
    values (v_tenant_id, btrim(p_name))
    returning * into v_customer;
  exception when unique_violation then
    if exists (
      select 1 from public.customers c
      where c.tenant_id = v_tenant_id
        and public.normalize_name(c.name) = public.normalize_name(p_name)
        and not c.active
    ) then
      raise exception 'Ya existe un cliente desactivado con ese nombre. Reactívalo en Clientes.' using errcode = '23505';
    end if;
    raise exception 'Ya existe un cliente con ese nombre.' using errcode = '23505';
  end;

  return v_customer;
end;
$$;

-- ============================================================
-- save_customers(): the customers grid's batch save
-- ============================================================
-- Same structure as save_products() (D3: one explicit RPC per table):
-- validate all → lock + conflict check → readable duplicates → write.
-- Differences: optional fiscal fields; only keys present in a row are
-- updated, so a grid save never nulls panel fields (outside voice #2);
-- tax_id / nrc / email / cod_actividad formats are checked on new rows and
-- on updates only when that field changed (outside voice #10), and stored
-- canonical.
--
-- p_rows: [{id?, name, phone?, address?, tax_id?, legal_name?, nrc?,
--           cod_actividad?, desc_actividad?, email?, active?, updated_at?}]
create or replace function public.save_customers(p_rows jsonb)
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
  v_current public.customers;
  v_new boolean;
  v_value text;
  v_conflicts jsonb := '[]'::jsonb;
  v_dupes text;
  v_saved int := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Explicit (learning: plpgsql-update-silent-noop-under-rls).
  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) != 'array' then
    raise exception 'rows must be an array' using errcode = '22004';
  end if;

  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Máximo 1000 clientes por guardado.' using errcode = '22023';
  end if;

  -- Lock every edited row up front in id order (no deadlock between two
  -- concurrent saves whose grids list the rows in different orders).
  perform 1
  from public.customers c
  where c.tenant_id = v_tenant_id
    and c.id in (select nullif(r->>'id', '')::uuid from jsonb_array_elements(p_rows) r)
  order by c.id
  for update;

  -- 1. Validate (and canonicalize) every row before touching anything.
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_id := nullif(v_row->>'id', '')::uuid;
    v_new := v_id is null;
    v_name := btrim(coalesce(v_row->>'name', ''));

    if v_name = '' then
      raise exception 'Falta el nombre de un cliente.' using errcode = '22004';
    end if;
    if length(v_name) > 200 then
      raise exception 'El nombre "%" es demasiado largo.', left(v_name, 40) using errcode = '22001';
    end if;

    if not v_new then
      -- for update: a concurrent save of the same row waits here, then sees
      -- the new updated_at and reports a conflict (no lost update).
      select * into v_current
      from public.customers c
      where c.id = v_id and c.tenant_id = v_tenant_id
      for update;

      if not found then
        raise exception 'Cliente no encontrado.' using errcode = 'P0002';
      end if;

      if v_current.updated_at is distinct from nullif(v_row->>'updated_at', '')::timestamptz then
        v_conflicts := v_conflicts || jsonb_build_object(
          'id', v_current.id,
          'name', v_current.name,
          'phone', v_current.phone,
          'address', v_current.address,
          'tax_id', v_current.tax_id,
          'legal_name', v_current.legal_name,
          'nrc', v_current.nrc,
          'cod_actividad', v_current.cod_actividad,
          'desc_actividad', v_current.desc_actividad,
          'email', v_current.email,
          'active', v_current.active,
          'updated_at', v_current.updated_at,
          'updated_by_name', (select u.name from public.users u where u.id = v_current.updated_by)
        );
      end if;
    end if;

    -- Free text: length only.
    if length(coalesce(v_row->>'phone', '')) > 100 then
      raise exception 'El teléfono de "%" es demasiado largo.', v_name using errcode = '22001';
    end if;
    if length(coalesce(v_row->>'address', '')) > 500 then
      raise exception 'La dirección de "%" es demasiado larga.', v_name using errcode = '22001';
    end if;
    if length(coalesce(v_row->>'legal_name', '')) > 200 or length(coalesce(v_row->>'desc_actividad', '')) > 200 then
      raise exception 'Un dato fiscal de "%" es demasiado largo.', v_name using errcode = '22001';
    end if;

    -- Formats: on new rows, or when the field changed (compared trimmed, as
    -- the grid sends it, so legacy whitespace doesn't count as a change).
    v_value := nullif(btrim(coalesce(v_row->>'tax_id', '')), '');
    if v_row ? 'tax_id' and v_value is not null and (v_new or v_value is distinct from btrim(v_current.tax_id)) then
      if public.normalize_tax_id(v_value) is null then
        raise exception 'El NIT o DUI de "%" no es válido.', v_name using errcode = '22023';
      end if;
      v_row := jsonb_set(v_row, '{tax_id}', to_jsonb(public.normalize_tax_id(v_value)));
    end if;

    v_value := nullif(btrim(coalesce(v_row->>'nrc', '')), '');
    if v_row ? 'nrc' and v_value is not null and (v_new or v_value is distinct from btrim(v_current.nrc)) then
      if public.normalize_nrc(v_value) is null then
        raise exception 'El NRC de "%" no es válido.', v_name using errcode = '22023';
      end if;
      v_row := jsonb_set(v_row, '{nrc}', to_jsonb(public.normalize_nrc(v_value)));
    end if;

    v_value := nullif(btrim(coalesce(v_row->>'email', '')), '');
    if v_row ? 'email' and v_value is not null and (v_new or v_value is distinct from btrim(v_current.email))
      and v_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'El correo de "%" no es válido.', v_name using errcode = '22023';
    end if;

    v_value := nullif(btrim(coalesce(v_row->>'cod_actividad', '')), '');
    if v_row ? 'cod_actividad' and v_value is not null and (v_new or v_value is distinct from btrim(v_current.cod_actividad))
      and v_value !~ '^[0-9]{5,6}$' then
      raise exception 'El código de actividad de "%" no es válido (5 o 6 dígitos).', v_name using errcode = '22023';
    end if;

    v_rows := v_rows || v_row;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('saved', 0, 'conflicts', v_conflicts);
  end if;

  -- 2. Readable duplicate check (the unique index stays the real guard).
  with batch as (
    select btrim(r->>'name') as name,
      public.normalize_name(r->>'name') as norm,
      nullif(r->>'id', '')::uuid as id
    from jsonb_array_elements(v_rows) r
  ),
  repeated as (
    select norm from batch group by norm having count(*) > 1
  )
  select string_agg(distinct b.name, ', ')
  into v_dupes
  from batch b
  where b.norm in (select norm from repeated)
    or exists (
      select 1 from public.customers c
      where c.tenant_id = v_tenant_id
        and public.normalize_name(c.name) = b.norm
        and c.id is distinct from b.id
        and not exists (select 1 from batch b2 where b2.id = c.id)
    );

  if v_dupes is not null then
    raise exception 'Ya existe: %', v_dupes using errcode = '23505';
  end if;

  -- 3. Write. Only keys present are updated (panel fields survive a grid save).
  begin
    for v_row in select * from jsonb_array_elements(v_rows)
    loop
      v_id := nullif(v_row->>'id', '')::uuid;

      if v_id is null then
        insert into public.customers (
          tenant_id, name, phone, address, tax_id, legal_name, nrc,
          cod_actividad, desc_actividad, email, active
        )
        values (
          v_tenant_id,
          btrim(v_row->>'name'),
          nullif(btrim(coalesce(v_row->>'phone', '')), ''),
          nullif(btrim(coalesce(v_row->>'address', '')), ''),
          nullif(btrim(coalesce(v_row->>'tax_id', '')), ''),
          nullif(btrim(coalesce(v_row->>'legal_name', '')), ''),
          nullif(btrim(coalesce(v_row->>'nrc', '')), ''),
          nullif(btrim(coalesce(v_row->>'cod_actividad', '')), ''),
          nullif(btrim(coalesce(v_row->>'desc_actividad', '')), ''),
          nullif(btrim(coalesce(v_row->>'email', '')), ''),
          coalesce((v_row->>'active')::boolean, true)
        );
      else
        update public.customers c
        set name = btrim(v_row->>'name'),
            phone = case when v_row ? 'phone' then nullif(btrim(coalesce(v_row->>'phone', '')), '') else c.phone end,
            address = case when v_row ? 'address' then nullif(btrim(coalesce(v_row->>'address', '')), '') else c.address end,
            tax_id = case when v_row ? 'tax_id' then nullif(btrim(coalesce(v_row->>'tax_id', '')), '') else c.tax_id end,
            legal_name = case when v_row ? 'legal_name' then nullif(btrim(coalesce(v_row->>'legal_name', '')), '') else c.legal_name end,
            nrc = case when v_row ? 'nrc' then nullif(btrim(coalesce(v_row->>'nrc', '')), '') else c.nrc end,
            cod_actividad = case when v_row ? 'cod_actividad' then nullif(btrim(coalesce(v_row->>'cod_actividad', '')), '') else c.cod_actividad end,
            desc_actividad = case when v_row ? 'desc_actividad' then nullif(btrim(coalesce(v_row->>'desc_actividad', '')), '') else c.desc_actividad end,
            email = case when v_row ? 'email' then nullif(btrim(coalesce(v_row->>'email', '')), '') else c.email end,
            active = coalesce((v_row->>'active')::boolean, c.active)
        where c.id = v_id and c.tenant_id = v_tenant_id;
      end if;

      v_saved := v_saved + 1;
    end loop;
  exception when unique_violation then
    raise exception 'Ya existe un cliente con ese nombre.' using errcode = '23505';
  end;

  return jsonb_build_object('saved', v_saved, 'conflicts', '[]'::jsonb);
end;
$$;

revoke all on function public.save_customers(jsonb) from public, anon;
grant execute on function public.save_customers(jsonb) to authenticated;
