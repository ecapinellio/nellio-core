-- T2: core tables, per-tenant RLS, unaccent/pg_trgm fuzzy search.
-- Schema per CLAUDE.md §4 and ADR-001 through ADR-008.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- unaccent() is only STABLE, not IMMUTABLE, so it can't be used directly
-- in a functional index. Wrap it so pg_trgm can index accent-insensitive
-- names (eng-review decision: single `name` column, no duplicated field).
create or replace function public.immutable_unaccent(text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, $1)
$$;

-- ============================================================
-- Helpers
-- ============================================================

-- ADR-003: lives in public because Supabase does not allow creating
-- functions in the auth schema. ADR-002: tenant_id travels in
-- app_metadata (server-controlled), never user_metadata.
create or replace function public.tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- Tables
-- ============================================================

-- Global, no tenant_id: this table defines what a tenant is.
-- Fiscal fields are the DTE emisor data (ADR-007), per Hacienda's
-- Manual Tecnológico V2.0 emisor object (nit, nrc, nombreComercial,
-- codActividad/descActividad, direccion, telefono, correo).
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nit text,
  nrc text,
  cod_actividad text,
  desc_actividad text,
  commercial_name text,
  address text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

-- Ligada a auth.users (ADR-004: users are internal staff, not customers).
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  role text not null check (role in ('admin', 'operator', 'driver')),
  created_at timestamptz not null default now()
);

-- ADR-004: customers are external businesses that place orders, not
-- software users. Fiscal fields are the DTE receptor data (ADR-007),
-- optional since not every customer has registered fiscal data yet.
-- `legal_name` is separate from `name` (the operational/search name,
-- often entered informally via quick-add and unlikely to match the
-- registered legal name).
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  legal_name text,
  tax_id text,
  nrc text,
  cod_actividad text,
  desc_actividad text,
  address text,
  phone text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Catalog only, no stock/cost fields yet (CLAUDE.md §4: inventory is
-- modeled post-discovery; design doc: margin stats are out of scope
-- until a cost field exists).
create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- `notes` holds the raw pasted WhatsApp message verbatim (eng-review
-- decision: capture is manual entry, no LLM/NLP extraction).
-- `channel` anticipates the future `portal` channel (ADR-008) without
-- building the portal itself.
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete restrict,
  created_by uuid references public.users (id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'dispatched', 'delivered')),
  channel text not null default 'whatsapp'
    check (channel in ('whatsapp', 'portal')),
  notes text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ADR-005: separate table from day one, even if most orders end up
-- with a single line item.
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity numeric(10, 2) not null check (quantity > 0),
  created_at timestamptz not null default now()
);

-- Always derive tenant_id from the parent order — never trust a
-- client-supplied value, same principle CLAUDE.md §6 applies to
-- user creation.
create or replace function public.set_order_item_tenant_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select tenant_id into new.tenant_id from public.orders where id = new.order_id;
  return new;
end;
$$;

create trigger order_items_set_tenant_id
  before insert on public.order_items
  for each row execute function public.set_order_item_tenant_id();

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ============================================================
-- Indexes
-- ============================================================

-- CLAUDE.md §7: always index tenant_id.
create index users_tenant_id_idx on public.users (tenant_id);
create index customers_tenant_id_idx on public.customers (tenant_id);
create index products_tenant_id_idx on public.products (tenant_id);
create index orders_tenant_id_idx on public.orders (tenant_id);
create index order_items_tenant_id_idx on public.order_items (tenant_id);

create index order_items_order_id_idx on public.order_items (order_id);

-- Same-day duplicate-order check (status-aware, per eng-review
-- decision): tenant + customer + created_at.
create index orders_dup_check_idx on public.orders (tenant_id, customer_id, created_at);

-- Fuzzy, accent-insensitive search (eng-review decision: pg_trgm +
-- unaccent, functional index, no duplicated column).
create index customers_name_trgm_idx
  on public.customers using gin (public.immutable_unaccent(name) extensions.gin_trgm_ops);
create index products_name_trgm_idx
  on public.products using gin (public.immutable_unaccent(name) extensions.gin_trgm_ops);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.tenants enable row level security;
alter table public.users enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- tenants: a user may only see their own tenant row. Writes only
-- happen via the service_role bootstrap script (CLAUDE.md §6), which
-- bypasses RLS entirely, so no INSERT/UPDATE/DELETE policy exists here.
create policy "tenants_select_own" on public.tenants
  for select
  using (id = public.tenant_id());

-- users: readable by teammates in the same tenant. Creation goes
-- through the service_role-backed Edge Function (CLAUDE.md §6), not
-- a client-facing INSERT policy, so none is defined here.
create policy "users_select_same_tenant" on public.users
  for select
  using (tenant_id = public.tenant_id());

-- customers, products, orders, order_items: per-tenant read+write for
-- this slice (eng-review decision — not per-role yet, driver has no
-- login). No DELETE policy: deletion is an explicit future decision.
create policy "customers_select_same_tenant" on public.customers
  for select
  using (tenant_id = public.tenant_id());
create policy "customers_insert_same_tenant" on public.customers
  for insert
  with check (tenant_id = public.tenant_id());
create policy "customers_update_same_tenant" on public.customers
  for update
  using (tenant_id = public.tenant_id())
  with check (tenant_id = public.tenant_id());

create policy "products_select_same_tenant" on public.products
  for select
  using (tenant_id = public.tenant_id());
create policy "products_insert_same_tenant" on public.products
  for insert
  with check (tenant_id = public.tenant_id());
create policy "products_update_same_tenant" on public.products
  for update
  using (tenant_id = public.tenant_id())
  with check (tenant_id = public.tenant_id());

create policy "orders_select_same_tenant" on public.orders
  for select
  using (tenant_id = public.tenant_id());
create policy "orders_insert_same_tenant" on public.orders
  for insert
  with check (tenant_id = public.tenant_id());
create policy "orders_update_same_tenant" on public.orders
  for update
  using (tenant_id = public.tenant_id())
  with check (tenant_id = public.tenant_id());

create policy "order_items_select_same_tenant" on public.order_items
  for select
  using (tenant_id = public.tenant_id());
create policy "order_items_insert_same_tenant" on public.order_items
  for insert
  with check (tenant_id = public.tenant_id());
create policy "order_items_update_same_tenant" on public.order_items
  for update
  using (tenant_id = public.tenant_id())
  with check (tenant_id = public.tenant_id());

-- ============================================================
-- Grants
-- ============================================================
-- Supabase does not grant table-level SELECT/INSERT/UPDATE/DELETE by
-- default (only TRUNCATE/REFERENCES/TRIGGER) — RLS above is the real
-- gate, these grants just make the operations reachable at all.
-- No `anon` grants: everything in Phase 1 requires login.

grant select on public.tenants to authenticated;
grant select on public.users to authenticated;
grant select, insert, update on public.customers to authenticated;
grant select, insert, update on public.products to authenticated;
grant select, insert, update on public.orders to authenticated;
grant select, insert, update on public.order_items to authenticated;

-- service_role bypasses RLS (rolbypassrls) but still needs base table
-- grants — bypassing row security doesn't imply table-level privileges.
-- Full CRUD: this is the platform-owner script / future Edge Function role.
grant select, insert, update, delete on public.tenants to service_role;
grant select, insert, update, delete on public.users to service_role;
grant select, insert, update, delete on public.customers to service_role;
grant select, insert, update, delete on public.products to service_role;
grant select, insert, update, delete on public.orders to service_role;
grant select, insert, update, delete on public.order_items to service_role;
