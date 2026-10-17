-- Security fix, found while implementing slice 1 of the product-pricing
-- block: every RPC's existing `revoke all on function X from public;`
-- never actually revoked anon's access. Postgres/Supabase grants EXECUTE to
-- anon, authenticated, and service_role directly (not via the PUBLIC
-- pseudo-role) on every new function by default — confirmed this is
-- standard Supabase platform behavior on hosted projects too, not a local
-- artifact. `revoke ... from public` only undoes grants made to PUBLIC, so
-- it never touched anon's separate, directly-granted privilege.
--
-- Practical impact before this fix: not a full bypass — every affected RPC
-- already checks public.tenant_id() internally and rejects a null tenant
-- (anon has none) with its own "Not authenticated" error. But the intended
-- database-privilege-level gate ("No anon grant — Phase 1 requires login",
-- per the comments in the T3/T4 migrations) was never actually enforced —
-- any future RPC that forgot its own internal check would have been fully
-- exposed to anon with zero protection.

revoke execute on function public.create_order(uuid, text, jsonb, text) from anon;
revoke execute on function public.search_customers(text, int) from anon;
revoke execute on function public.search_products(text, int) from anon;
revoke execute on function public.quick_add_customer(text) from anon;
revoke execute on function public.quick_add_product(text, numeric, text) from anon;

-- Closes the Supabase-specific half of this gap for every future function
-- created by the `postgres` role (what migrations run as) — without this,
-- any new function would again default to anon-executable via this
-- mechanism, same as quick_add_product's extended signature in this very
-- migration silently did, purely by being newly created.
--
-- This does NOT make the per-function `revoke all on function X from
-- public;` line obsolete — that line is Postgres's own separate baseline
-- (CREATE FUNCTION grants execute to the PUBLIC role, independent of
-- Supabase's defaults, and anon inherits from PUBLIC), and every migration
-- creating a security-sensitive function must keep including it, same as
-- all of them already do.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;
