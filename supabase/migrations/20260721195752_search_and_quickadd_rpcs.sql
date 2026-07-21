-- T4: search + quick-add RPCs backing the query helpers layer.
--
-- Search can't be expressed as a plain PostgREST filter: the trigram index
-- (T2) is functional, on immutable_unaccent(name), and pg_trgm's `%`/
-- similarity() live in the `extensions` schema — none of that is reachable
-- through supabase-js's column-filter API, so it needs a SQL function.
--
-- Quick-add mirrors create_order()'s and the order_items trigger's existing
-- rule: tenant_id is always derived server-side from public.tenant_id(),
-- never accepted from the client, even though RLS's WITH CHECK would also
-- catch a wrong value.

create or replace function public.search_customers(p_query text, p_limit int default 10)
returns setof public.customers
language sql
stable
security invoker
set search_path = ''
as $$
  select c.*
  from public.customers c
  where c.tenant_id = public.tenant_id()
    and (
      p_query is null or btrim(p_query) = ''
      or public.immutable_unaccent(c.name)
        OPERATOR(extensions.%) public.immutable_unaccent(p_query)
    )
  order by
    case when p_query is null or btrim(p_query) = '' then null
      else extensions.similarity(public.immutable_unaccent(c.name), public.immutable_unaccent(p_query))
    end desc nulls last,
    c.name asc
  limit greatest(p_limit, 0)
$$;

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

  insert into public.customers (tenant_id, name)
  values (v_tenant_id, btrim(p_name))
  returning * into v_customer;

  return v_customer;
end;
$$;

create or replace function public.quick_add_product(p_name text)
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

  insert into public.products (tenant_id, name)
  values (v_tenant_id, btrim(p_name))
  returning * into v_product;

  return v_product;
end;
$$;

-- Same rationale as create_order(): explicit over PUBLIC's default EXECUTE
-- grant, no anon grant (Phase 1 requires login).
revoke all on function public.search_customers(text, int) from public;
revoke all on function public.search_products(text, int) from public;
revoke all on function public.quick_add_customer(text) from public;
revoke all on function public.quick_add_product(text) from public;

grant execute on function public.search_customers(text, int) to authenticated;
grant execute on function public.search_products(text, int) to authenticated;
grant execute on function public.quick_add_customer(text) to authenticated;
grant execute on function public.quick_add_product(text) to authenticated;
