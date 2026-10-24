-- Admin self-service user creation (eng review Decision 13): tracks which
-- admin created each user, same audit-trail habit as order_items'
-- price_overridden_by. Nullable — the bootstrap script's first admin per
-- tenant has no calling admin. on delete set null (not cascade): deleting
-- the creating admin later shouldn't delete the users they created.
alter table public.users
  add column created_by uuid references auth.users (id) on delete set null;
