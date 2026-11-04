-- Name and length limits as table CHECKs (TODOS: "Direct writes still skip
-- name and length limits"). save_customers() / save_products() already
-- enforce them, but a direct PostgREST write (or quick_add_*, which never had
-- a length limit) could store a blank name or a 200,000-character phone.
-- The RPCs keep their own checks for the readable Spanish messages; these
-- are the backstop.
--
-- Validated, not NOT VALID: a NOT VALID check still applies to every UPDATE,
-- so a legacy bad row would block unrelated edits anyway. If existing data
-- breaks a rule, this migration fails as a whole and nothing changes.
--
-- Names: at least one non-space character ([[:space:]] also catches tabs and
-- newlines, which the RPCs' btrim() lets through).

alter table public.customers
  add constraint customers_name_check
    check (name ~ '[^[:space:]]' and char_length(name) <= 200),
  add constraint customers_phone_length_check
    check (char_length(phone) <= 100),
  add constraint customers_address_length_check
    check (char_length(address) <= 500),
  add constraint customers_legal_name_length_check
    check (char_length(legal_name) <= 200),
  add constraint customers_desc_actividad_length_check
    check (char_length(desc_actividad) <= 200),
  -- Format is checked by customers_check_formats; this caps the length (RFC 5321).
  add constraint customers_email_length_check
    check (char_length(email) <= 254);

alter table public.products
  add constraint products_name_check
    check (name ~ '[^[:space:]]' and char_length(name) <= 200);

-- Price: numeric(10,2) rounded 1.005 to 1.01 without telling anyone. Plain
-- numeric keeps what was sent, so the check can reject extra decimals, same
-- as save_products(). Same limit as before (99,999,999.99); the upper bound
-- also rejects 'Infinity', which numeric(10,2) used to refuse by itself.
-- Dropping the typmod doesn't rewrite the table.
alter table public.products
  drop constraint products_price_per_unit_check;

alter table public.products
  alter column price_per_unit type numeric;

alter table public.products
  add constraint products_price_per_unit_check
    check (
      price_per_unit is null
      or (
        price_per_unit > 0
        and price_per_unit <> 'NaN'::numeric
        and price_per_unit <= 99999999.99
        and price_per_unit = round(price_per_unit, 2)
      )
    );
