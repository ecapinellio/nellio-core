-- RBAC Slice 3 (user management). Two changes:
--
-- 1. public.tenant_id() now fails closed when the caller's session is dead.
--    An access token stays cryptographically valid until it expires
--    (jwt_expiry = 3600), so before this a deactivated user (auth ban) or a
--    user whose password was just reset could keep reading/writing their
--    tenant's data straight through PostgREST for up to an hour. Verified
--    locally (2026-10-24): a ban keeps the auth.sessions row but sets
--    auth.users.banned_until; an admin password change deletes the
--    auth.sessions row. Checking both here covers deactivate, reset and
--    reactivate at once, and every policy and RPC already funnels through
--    this function (ADR-003), so none of them needs its own check.
--
--    security definer: the `authenticated` role can't read auth.sessions /
--    auth.users itself.
--
-- 2. public.list_tenant_users() for the /admin/users list: one query that
--    joins auth.users for email + banned_until, instead of N service_role
--    getUserById calls from the page.

create or replace function public.tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
  where exists (
    select 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = auth.uid()
      and (u.banned_until is null or u.banned_until <= now())
  )
$$;

-- ============================================================
-- Policies: wrap the helpers in (select ...) so Postgres evaluates them
-- once per statement (initPlan) instead of once per row — tenant_id() now
-- does two lookups, which would otherwise run for every row scanned.
-- Same predicates as before, nothing else changes.
-- ============================================================

alter policy "customers_select_same_tenant" on public.customers
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "customers_insert_same_tenant" on public.customers
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "customers_update_same_tenant" on public.customers
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()))
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));

alter policy "products_select_same_tenant" on public.products
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "products_insert_same_tenant" on public.products
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "products_update_same_tenant" on public.products
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()))
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));

alter policy "orders_select_same_tenant" on public.orders
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "orders_insert_same_tenant" on public.orders
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "orders_update_same_tenant" on public.orders
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()))
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));

alter policy "order_items_select_same_tenant" on public.order_items
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "order_items_insert_same_tenant" on public.order_items
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
alter policy "order_items_update_same_tenant" on public.order_items
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()))
  with check (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));

alter policy "tenants_select_own" on public.tenants
  using (id = (select public.tenant_id()));

alter policy "users_select_same_tenant" on public.users
  using (tenant_id = (select public.tenant_id()));

-- ============================================================
-- list_tenant_users(): admin-only, own tenant only.
-- ============================================================

create or replace function public.list_tenant_users()
returns table (
  id uuid,
  name text,
  role text,
  created_at timestamptz,
  created_by uuid,
  email text,
  banned_until timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  v_tenant_id := public.tenant_id();
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- `is distinct from`, not `!=` — same NULL-role reasoning as
  -- get_today_stats().
  if public.role() is distinct from 'admin' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select u.id, u.name, u.role, u.created_at, u.created_by, a.email::text, a.banned_until
    from public.users u
    join auth.users a on a.id = u.id
    where u.tenant_id = v_tenant_id
    order by u.name;
end;
$$;

revoke all on function public.list_tenant_users() from public;
revoke execute on function public.list_tenant_users() from anon;
grant execute on function public.list_tenant_users() to authenticated;
