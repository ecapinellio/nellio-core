-- Security audit fixes (2026-11-03).
--
-- 1. tenant_id() also returns NULL while the user still has to replace an
--    admin-generated password (app_metadata.must_change_password). Before,
--    only the proxy and the Server Actions enforced it: whoever had the
--    temporary password could sign in straight against the API (anon key is
--    public) and read/write the tenant's data without ever changing it.
--    Read from auth.users, not the JWT, so clearing the flag takes effect at
--    once (same reasoning as the ban check, ADR-009). jsonb `true` only —
--    same rule as mustChangePassword() in lib/auth/password.ts.
--
-- 2. Audit columns can't be forged through direct PostgREST writes:
--    - order_items.price_overridden_by/at are stamped by the database
--      whenever price_at_order changes, and can't be set otherwise.
--    - orders.created_by is the inserting user and never changes.
--    Before, an operator could PATCH a price without leaving a trace, or put
--    a colleague's id on it.
--    Only enforced for signed-in users (auth.uid() not null) and outside
--    nested triggers: `on delete set null` on these FKs runs as an UPDATE
--    from a trigger, and restoring the old value there would block deleting
--    a user. service_role (scripts, tests) has no auth.uid().

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
      and (u.raw_app_meta_data -> 'must_change_password') is distinct from 'true'::jsonb
  )
$$;

-- ============================================================
-- order_items: price override audit stamped by the database
-- ============================================================
create or replace function public.stamp_price_override()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- create_order()'s snapshot is not an override.
    new.price_overridden_by := null;
    new.price_overridden_at := null;
  elsif new.price_at_order is distinct from old.price_at_order then
    new.price_overridden_by := auth.uid();
    new.price_overridden_at := now();
  else
    new.price_overridden_by := old.price_overridden_by;
    new.price_overridden_at := old.price_overridden_at;
  end if;

  return new;
end;
$$;

create trigger order_items_stamp_price_override
  before insert or update on public.order_items
  for each row execute function public.stamp_price_override();

-- ============================================================
-- orders: created_by is the creator, fixed
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
  else
    new.created_by := old.created_by;
  end if;

  return new;
end;
$$;

create trigger orders_stamp_created_by
  before insert or update on public.orders
  for each row execute function public.stamp_order_created_by();
