-- Two cleanups on the catalog save paths (TODOS.md):
-- 1. Swapping names (A→B + B→A) in one grid save no longer fails.
-- 2. Customer formats hold on direct PostgREST writes too, not only in
--    save_customers().

-- ============================================================
-- Name swaps: save_products() / save_customers()
-- ============================================================
-- Recreated unchanged except for the "give up their name" update.
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
    -- Renamed rows give up their name first: the unique index is checked row
    -- by row, so A→B + B→A would otherwise fail on a valid batch.
    update public.products p
    set name = p.id::text
    from jsonb_array_elements(p_rows) r
    where p.id = nullif(r->>'id', '')::uuid
      and p.tenant_id = v_tenant_id
      and public.normalize_name(p.name) <> public.normalize_name(r->>'name');

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
    -- Renamed rows give up their name first (see save_products()).
    update public.customers c
    set name = c.id::text
    from jsonb_array_elements(v_rows) r
    where c.id = nullif(r->>'id', '')::uuid
      and c.tenant_id = v_tenant_id
      and public.normalize_name(c.name) <> public.normalize_name(r->>'name');

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

-- ============================================================
-- Customer formats on the table
-- ============================================================
-- A trigger, not CHECK constraints: a NOT VALID check still re-validates a
-- legacy row on every update, so a customer with "NIT pendiente" couldn't
-- even change its phone. Revoking direct writes isn't an option either: the
-- security invoker RPCs write with the caller's own privileges.
--
-- Same rule as save_customers(): only values that changed (compared trimmed)
-- are checked, and they're stored canonical. API roles only, so scripts and
-- migrations can still load data as is.
create or replace function public.check_customer_formats()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_value text;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if btrim(new.tax_id) is distinct from btrim(old.tax_id) then
    v_value := nullif(btrim(new.tax_id), '');
    new.tax_id := public.normalize_tax_id(v_value);
    if v_value is not null and new.tax_id is null then
      raise exception 'El NIT o DUI de "%" no es válido.', new.name using errcode = '22023';
    end if;
  end if;

  if btrim(new.nrc) is distinct from btrim(old.nrc) then
    v_value := nullif(btrim(new.nrc), '');
    new.nrc := public.normalize_nrc(v_value);
    if v_value is not null and new.nrc is null then
      raise exception 'El NRC de "%" no es válido.', new.name using errcode = '22023';
    end if;
  end if;

  if btrim(new.email) is distinct from btrim(old.email) then
    new.email := nullif(btrim(new.email), '');
    if new.email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'El correo de "%" no es válido.', new.name using errcode = '22023';
    end if;
  end if;

  if btrim(new.cod_actividad) is distinct from btrim(old.cod_actividad) then
    new.cod_actividad := nullif(btrim(new.cod_actividad), '');
    if new.cod_actividad !~ '^[0-9]{5,6}$' then
      raise exception 'El código de actividad de "%" no es válido (5 o 6 dígitos).', new.name using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

create trigger customers_check_formats
  before insert or update of tax_id, nrc, email, cod_actividad on public.customers
  for each row execute function public.check_customer_formats();
