-- T8: role() helper + RLS enforcement for admin/operator/driver (ADR-006).
-- Driver loses SELECT too, not just write, on the capture-flow tables — matches
-- CLAUDE.md's "Vistas del frontend por rol" (driver = No on Capture/Tracking/
-- Operaciones). A future policy scoping driver to their own assigned orders is
-- expected once the delivery/assignment data model exists (CLAUDE.md §4).

-- ============================================================
-- Helpers
-- ============================================================

-- Mirrors public.tenant_id() (ADR-003): role travels in app_metadata
-- (server-controlled, ADR-002), never user_metadata.
create or replace function public.role()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

-- Centralizes the admin/operator check so it isn't repeated across every
-- RLS policy below (same DRY rationale ADR-003 gives for tenant_id()).
create or replace function public.is_operator_or_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.role() in ('admin', 'operator')
$$;

-- ============================================================
-- RLS: customers
-- ============================================================

drop policy if exists "customers_select_same_tenant" on public.customers;
create policy "customers_select_same_tenant" on public.customers
  for select
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "customers_insert_same_tenant" on public.customers;
create policy "customers_insert_same_tenant" on public.customers
  for insert
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "customers_update_same_tenant" on public.customers;
create policy "customers_update_same_tenant" on public.customers
  for update
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin())
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

-- ============================================================
-- RLS: products
-- ============================================================

drop policy if exists "products_select_same_tenant" on public.products;
create policy "products_select_same_tenant" on public.products
  for select
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "products_insert_same_tenant" on public.products;
create policy "products_insert_same_tenant" on public.products
  for insert
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "products_update_same_tenant" on public.products;
create policy "products_update_same_tenant" on public.products
  for update
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin())
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

-- ============================================================
-- RLS: orders
-- ============================================================

drop policy if exists "orders_select_same_tenant" on public.orders;
create policy "orders_select_same_tenant" on public.orders
  for select
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "orders_insert_same_tenant" on public.orders;
create policy "orders_insert_same_tenant" on public.orders
  for insert
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "orders_update_same_tenant" on public.orders;
create policy "orders_update_same_tenant" on public.orders
  for update
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin())
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

-- ============================================================
-- RLS: order_items
-- ============================================================

drop policy if exists "order_items_select_same_tenant" on public.order_items;
create policy "order_items_select_same_tenant" on public.order_items
  for select
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "order_items_insert_same_tenant" on public.order_items;
create policy "order_items_insert_same_tenant" on public.order_items
  for insert
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());

drop policy if exists "order_items_update_same_tenant" on public.order_items;
create policy "order_items_update_same_tenant" on public.order_items
  for update
  using (tenant_id = public.tenant_id() and public.is_operator_or_admin())
  with check (tenant_id = public.tenant_id() and public.is_operator_or_admin());
