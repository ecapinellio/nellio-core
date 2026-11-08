-- Fulfillment phase 4: DTE (El Salvador electronic invoice), ADR-015.
--
-- Delivering an order already sets orders.invoice_status = 'pending'. A
-- trigger turns that into a dte_documents row (same transaction), and the
-- cron route app/api/cron/dte builds, signs and transmits it to Hacienda
-- (same outbox shape as ADR-013): invoicing never blocks or undoes a delivery.
--
-- Field rules come from Hacienda's JSON Schemas (fe-f-v2, fe-ccf-v4,
-- invalidacion-schema-v3, 2026-08-11) and Catálogos v1.2 (factura.gob.sv).

-- ============================================================
-- Emisor data on tenants
-- ============================================================
alter table public.tenants
  add column legal_name text check (char_length(legal_name) between 1 and 250),
  -- CAT-012 departamento / CAT-013 municipio / CAT-008 distrito; address is the complemento.
  add column department_code text check (department_code ~ '^[0-9]{2}$'),
  add column municipality_code text check (municipality_code ~ '^[0-9]{2}$'),
  add column district_code text check (district_code ~ '^[0-9]{2}$'),
  -- Contributor's own codes: codEstable / codPuntoVenta and the numeroControl's third section.
  add column establishment_code text not null default 'M001' check (establishment_code ~ '^[MBSP][0-9]{3}$'),
  add column pos_code text not null default 'P001' check (pos_code ~ '^P[0-9]{3}$'),
  -- Codes Hacienda assigns (the invalidation event requires them).
  add column mh_establishment_code text check (char_length(mh_establishment_code) = 4),
  add column mh_pos_code text check (char_length(mh_pos_code) = 4),
  add column prices_include_vat boolean not null default false,
  add column dte_environment text not null default '00' check (dte_environment in ('00', '01')),
  add column dte_enabled boolean not null default false,
  -- Last time DTE was turned on: delivered orders after it must have a DTE (dte_backlog).
  add column dte_enabled_at timestamptz,
  -- not valid: existing rows (loaded by script) aren't rechecked until edited.
  add constraint tenants_nit_format check (nit is null or public.normalize_tax_id(nit) = nit) not valid,
  add constraint tenants_nrc_format check (nrc is null or public.normalize_nrc(nrc) = nrc) not valid,
  add constraint tenants_cod_actividad_format check (cod_actividad ~ '^[0-9]{5,6}$') not valid,
  add constraint tenants_desc_actividad_length check (char_length(desc_actividad) between 5 and 150) not valid,
  add constraint tenants_commercial_name_length check (char_length(commercial_name) <= 150) not valid,
  add constraint tenants_address_length check (char_length(address) <= 200) not valid,
  add constraint tenants_phone_length check (char_length(phone) between 8 and 30) not valid,
  add constraint tenants_email_format check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(email) <= 100) not valid;

-- ============================================================
-- Receptor location on customers (address stays the complemento)
-- ============================================================
alter table public.customers
  add column department_code text check (department_code ~ '^[0-9]{2}$'),
  add column municipality_code text check (municipality_code ~ '^[0-9]{2}$'),
  add column district_code text check (district_code ~ '^[0-9]{2}$');

-- ============================================================
-- Credentials: Supabase Vault, never readable by API roles
-- ============================================================
create table public.tenant_dte_credentials (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  certificate_secret uuid not null,
  key_password_secret uuid not null,
  api_password_secret uuid not null,
  -- Ambiente the tenant had when they were saved: test credentials never sign production DTEs.
  environment text not null check (environment in ('00', '01')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);
alter table public.tenant_dte_credentials enable row level security;
revoke all on public.tenant_dte_credentials from anon, authenticated;

-- Admin of the caller's own tenant. A null argument keeps the stored value,
-- so the admin can change only the API password; the first save needs all three.
create or replace function public.set_dte_credentials(
  p_certificate text, p_key_password text, p_api_password text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_row public.tenant_dte_credentials;
  v_cert text := nullif(btrim(p_certificate), '');
  v_key text := nullif(p_key_password, '');
  v_api text := nullif(p_api_password, '');
  v_env text := (select t.dte_environment from public.tenants t where t.id = public.tenant_id());
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.role() is distinct from 'admin' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if v_cert is not null and (char_length(v_cert) > 50000 or position('<privateKey>' in v_cert) = 0) then
    raise exception 'El archivo no parece un certificado de Hacienda (.crt).' using errcode = '22023';
  end if;
  if char_length(v_key) > 200 or char_length(v_api) > 200 then
    raise exception 'Contraseña demasiado larga.' using errcode = '22001';
  end if;

  select * into v_row from public.tenant_dte_credentials c where c.tenant_id = v_tenant_id for update;
  if not found then
    if v_cert is null or v_key is null or v_api is null then
      raise exception 'Falta el certificado, la clave privada o la contraseña API.' using errcode = '22004';
    end if;
    insert into public.tenant_dte_credentials (tenant_id, certificate_secret, key_password_secret, api_password_secret, environment, updated_by)
    values (
      v_tenant_id,
      vault.create_secret(v_cert, 'dte_certificate_' || v_tenant_id),
      vault.create_secret(v_key, 'dte_key_password_' || v_tenant_id),
      vault.create_secret(v_api, 'dte_api_password_' || v_tenant_id),
      v_env,
      auth.uid()
    );
    return;
  end if;

  if v_row.environment <> v_env and (v_cert is null or v_key is null or v_api is null) then
    raise exception 'Cambiaste de ambiente: sube el certificado y las dos contraseñas del ambiente nuevo.' using errcode = '22004';
  end if;
  if v_cert is not null then perform vault.update_secret(v_row.certificate_secret, v_cert); end if;
  if v_key is not null then perform vault.update_secret(v_row.key_password_secret, v_key); end if;
  if v_api is not null then perform vault.update_secret(v_row.api_password_secret, v_api); end if;
  update public.tenant_dte_credentials set environment = v_env, updated_at = now(), updated_by = auth.uid()
  where tenant_id = v_tenant_id;
end;
$$;
revoke execute on function public.set_dte_credentials(text, text, text) from public, anon;
grant execute on function public.set_dte_credentials(text, text, text) to authenticated;

-- What the admin screen may know: whether they exist, never the values.
create or replace function public.dte_credentials_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.role() = 'admin' then
    coalesce(
      (select jsonb_build_object('configured', true, 'updated_at', c.updated_at, 'environment', c.environment)
       from public.tenant_dte_credentials c where c.tenant_id = public.tenant_id()),
      jsonb_build_object('configured', false, 'updated_at', null, 'environment', null))
  end
$$;
revoke execute on function public.dte_credentials_status() from public, anon;
grant execute on function public.dte_credentials_status() to authenticated;

-- The sender (service_role only) reads the decrypted values.
create or replace function public.get_dte_credentials(p_tenant_id uuid)
returns table (certificate text, key_password text, api_password text, environment text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = c.certificate_secret),
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = c.key_password_secret),
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = c.api_password_secret),
    c.environment
  from public.tenant_dte_credentials c
  where c.tenant_id = p_tenant_id
$$;
revoke execute on function public.get_dte_credentials(uuid) from public, anon, authenticated;
grant execute on function public.get_dte_credentials(uuid) to service_role;

-- ============================================================
-- save_company_fiscal: the admin edits the emisor data
-- ============================================================
-- tenants has no UPDATE grant for authenticated (and keeps none): this
-- definer RPC is the only write path, scoped to the caller's tenant.
-- Only keys present are written; '' clears a nullable field.
create or replace function public.save_company_fiscal(p_data jsonb)
returns public.tenants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_t public.tenants;
  v_value text;
  v_missing text[] := '{}';
  v_was_enabled boolean;
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if public.role() is distinct from 'admin' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'data must be an object' using errcode = '22004';
  end if;

  select * into v_t from public.tenants t where t.id = v_tenant_id for update;
  v_was_enabled := v_t.dte_enabled;

  v_value := nullif(btrim(coalesce(p_data ->> 'nit', '')), '');
  if p_data ? 'nit' then
    v_t.nit := public.normalize_tax_id(v_value);
    if v_value is not null and v_t.nit is null then
      raise exception 'El NIT no es válido.' using errcode = '22023';
    end if;
  end if;
  v_value := nullif(btrim(coalesce(p_data ->> 'nrc', '')), '');
  if p_data ? 'nrc' then
    v_t.nrc := public.normalize_nrc(v_value);
    if v_value is not null and v_t.nrc is null then
      raise exception 'El NRC no es válido.' using errcode = '22023';
    end if;
  end if;

  if p_data ? 'legal_name' then v_t.legal_name := nullif(btrim(p_data ->> 'legal_name'), ''); end if;
  if p_data ? 'commercial_name' then v_t.commercial_name := nullif(btrim(p_data ->> 'commercial_name'), ''); end if;
  if p_data ? 'cod_actividad' then v_t.cod_actividad := nullif(btrim(p_data ->> 'cod_actividad'), ''); end if;
  if p_data ? 'desc_actividad' then v_t.desc_actividad := nullif(btrim(p_data ->> 'desc_actividad'), ''); end if;
  if p_data ? 'department_code' then v_t.department_code := nullif(btrim(p_data ->> 'department_code'), ''); end if;
  if p_data ? 'municipality_code' then v_t.municipality_code := nullif(btrim(p_data ->> 'municipality_code'), ''); end if;
  if p_data ? 'district_code' then v_t.district_code := nullif(btrim(p_data ->> 'district_code'), ''); end if;
  if p_data ? 'address' then v_t.address := nullif(btrim(p_data ->> 'address'), ''); end if;
  if p_data ? 'phone' then v_t.phone := nullif(btrim(p_data ->> 'phone'), ''); end if;
  if p_data ? 'email' then v_t.email := nullif(btrim(p_data ->> 'email'), ''); end if;
  if p_data ? 'establishment_code' then v_t.establishment_code := upper(btrim(p_data ->> 'establishment_code')); end if;
  if p_data ? 'pos_code' then v_t.pos_code := upper(btrim(p_data ->> 'pos_code')); end if;
  if p_data ? 'mh_establishment_code' then v_t.mh_establishment_code := nullif(btrim(p_data ->> 'mh_establishment_code'), ''); end if;
  if p_data ? 'mh_pos_code' then v_t.mh_pos_code := nullif(btrim(p_data ->> 'mh_pos_code'), ''); end if;
  if p_data ? 'prices_include_vat' then v_t.prices_include_vat := (p_data ->> 'prices_include_vat')::boolean; end if;
  if p_data ? 'dte_environment' then v_t.dte_environment := p_data ->> 'dte_environment'; end if;
  if p_data ? 'dte_enabled' then v_t.dte_enabled := (p_data ->> 'dte_enabled')::boolean; end if;

  -- Turning DTE on with incomplete data would only fill the queue with errors.
  if v_t.dte_enabled then
    if v_t.nit is null then v_missing := array_append(v_missing, 'NIT'); end if;
    if v_t.nrc is null then v_missing := array_append(v_missing, 'NRC'); end if;
    if v_t.legal_name is null then v_missing := array_append(v_missing, 'razón social'); end if;
    if v_t.cod_actividad is null or v_t.desc_actividad is null then v_missing := array_append(v_missing, 'actividad económica'); end if;
    if v_t.department_code is null or v_t.municipality_code is null or v_t.district_code is null or v_t.address is null then
      v_missing := array_append(v_missing, 'dirección');
    end if;
    if v_t.phone is null then v_missing := array_append(v_missing, 'teléfono'); end if;
    if v_t.email is null then v_missing := array_append(v_missing, 'correo'); end if;
    if not exists (select 1 from public.tenant_dte_credentials c
                   where c.tenant_id = v_tenant_id and c.environment = v_t.dte_environment) then
      v_missing := array_append(v_missing, 'credenciales de Hacienda del ambiente de '
        || case v_t.dte_environment when '01' then 'Producción' else 'Pruebas' end);
    end if;
    if cardinality(v_missing) > 0 then
      raise exception 'Para activar el DTE falta: %.', array_to_string(v_missing, ', ') using errcode = '22023';
    end if;
  end if;

  begin
    update public.tenants t set
      nit = v_t.nit, nrc = v_t.nrc, legal_name = v_t.legal_name, commercial_name = v_t.commercial_name,
      cod_actividad = v_t.cod_actividad, desc_actividad = v_t.desc_actividad,
      department_code = v_t.department_code, municipality_code = v_t.municipality_code,
      district_code = v_t.district_code, address = v_t.address, phone = v_t.phone, email = v_t.email,
      establishment_code = v_t.establishment_code, pos_code = v_t.pos_code,
      mh_establishment_code = v_t.mh_establishment_code, mh_pos_code = v_t.mh_pos_code,
      prices_include_vat = v_t.prices_include_vat, dte_environment = v_t.dte_environment,
      dte_enabled = v_t.dte_enabled,
      dte_enabled_at = case when v_t.dte_enabled and not v_was_enabled then now() else v_t.dte_enabled_at end
    where t.id = v_tenant_id
    returning * into v_t;
  exception when check_violation then
    raise exception 'Un dato fiscal no tiene el formato que pide Hacienda (%).', sqlerrm using errcode = '22023';
  end;
  return v_t;
end;
$$;
revoke execute on function public.save_company_fiscal(jsonb) from public, anon;
grant execute on function public.save_company_fiscal(jsonb) to authenticated;

-- ============================================================
-- dte_documents: one row per DTE sent (or to send) to Hacienda
-- ============================================================
create table public.dte_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'issued', 'rejected', 'error', 'invalidated')),
  -- Set on the first build; kept across retries (resending the same codes is
  -- what lets the sender ask Hacienda whether a lost response was received).
  dte_type text check (dte_type in ('01', '03')),
  environment text check (environment in ('00', '01')),
  control_number text,
  generation_code text unique,
  document jsonb,
  reception_seal text,
  processed_at timestamptz,
  response jsonb,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  invalidated_at timestamptz,
  invalidation_seal text,
  created_at timestamptz not null default now(),
  unique (tenant_id, environment, control_number)
);
create index dte_documents_order_idx on public.dte_documents (tenant_id, order_id);
create index dte_documents_queued_idx on public.dte_documents (next_attempt_at) where status = 'queued';
-- One live DTE per order.
create unique index dte_documents_live_idx on public.dte_documents (order_id)
  where status in ('queued', 'issued');

alter table public.dte_documents enable row level security;
create policy dte_documents_select on public.dte_documents
  for select to authenticated
  using (tenant_id = (select public.tenant_id()) and (select public.is_operator_or_admin()));
revoke all on public.dte_documents from anon, authenticated;
grant select on public.dte_documents to authenticated;
grant select, insert, update, delete on public.dte_documents to service_role;

-- Correlativo per tenant, ambiente and document type (Manual Funcional V2.0,
-- XI: sequential, never repeated within a calendar year). Per ambiente so the
-- test DTEs don't use up production numbers: production starts at 1.
create table public.dte_sequences (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  environment text not null check (environment in ('00', '01')),
  dte_type text not null check (dte_type in ('01', '03')),
  last_number bigint not null default 0,
  primary key (tenant_id, environment, dte_type)
);
alter table public.dte_sequences enable row level security;
revoke all on public.dte_sequences from anon, authenticated;

-- Service_role only. Idempotent: a document that already has its numbers
-- keeps them (a retry never burns a number). A type change (the customer got
-- an NRC between attempts) takes a new number of the new type.
create or replace function public.assign_dte_number(p_doc_id uuid, p_dte_type text)
returns public.dte_documents
language plpgsql
set search_path = ''
as $$
declare
  v_doc public.dte_documents;
  v_t public.tenants;
  v_n bigint;
begin
  select * into v_doc from public.dte_documents d where d.id = p_doc_id for update;
  if not found then
    raise exception 'DTE % not found', p_doc_id using errcode = 'P0002';
  end if;
  select * into v_t from public.tenants t where t.id = v_doc.tenant_id;
  -- An ambiente change (pruebas -> producción) also takes a new number.
  if v_doc.control_number is not null and v_doc.dte_type = p_dte_type and v_doc.environment = v_t.dte_environment then
    return v_doc;
  end if;

  insert into public.dte_sequences as s (tenant_id, environment, dte_type, last_number)
  values (v_doc.tenant_id, v_t.dte_environment, p_dte_type, 1)
  on conflict (tenant_id, environment, dte_type) do update set last_number = s.last_number + 1
  returning last_number into v_n;

  update public.dte_documents d set
    dte_type = p_dte_type,
    environment = v_t.dte_environment,
    control_number = 'DTE-' || p_dte_type || '-' || v_t.establishment_code || v_t.pos_code || '-' || lpad(v_n::text, 15, '0'),
    generation_code = upper(gen_random_uuid()::text)
  where d.id = p_doc_id
  returning * into v_doc;
  return v_doc;
end;
$$;
revoke execute on function public.assign_dte_number(uuid, text) from public, anon, authenticated;
grant execute on function public.assign_dte_number(uuid, text) to service_role;

-- Same claim shape as claim_order_notifications().
create or replace function public.claim_dte_documents(p_limit int)
returns setof public.dte_documents
language sql
set search_path = ''
as $$
  update public.dte_documents d
  set attempts = d.attempts + 1,
      next_attempt_at = now() + interval '15 minutes'
  where d.id in (
    select q.id from public.dte_documents q
    where q.status = 'queued' and q.next_attempt_at <= now()
    order by q.created_at
    limit p_limit
    for update skip locked
  )
  returning d.*
$$;
revoke execute on function public.claim_dte_documents(int) from public, anon, authenticated;
grant execute on function public.claim_dte_documents(int) to service_role;

-- ============================================================
-- Order event 'invoice' (DTE issued) — written by the sender
-- ============================================================
alter table public.order_events drop constraint order_events_action_check;
alter table public.order_events add constraint order_events_action_check
  check (action in ('create', 'assign', 'reject', 'accept', 'pick_up', 'deliver', 'fail', 'cancel', 'correct', 'invoice'));

-- Service_role only: the terminal outcome of a DTE, its order's
-- invoice_status and (when issued) the 'invoice' event, in one transaction.
create or replace function public.finish_dte(
  p_doc_id uuid, p_status text, p_seal text default null, p_processed_at timestamptz default null,
  p_response jsonb default null, p_error text default null
)
returns public.dte_documents
language plpgsql
set search_path = ''
as $$
declare
  v_doc public.dte_documents;
  v_order public.orders;
begin
  if p_status not in ('issued', 'rejected', 'error') then
    raise exception 'Invalid DTE status %', p_status using errcode = '22023';
  end if;
  update public.dte_documents d set
    status = p_status,
    reception_seal = coalesce(p_seal, d.reception_seal),
    processed_at = coalesce(p_processed_at, d.processed_at),
    response = coalesce(p_response, d.response),
    last_error = p_error
  where d.id = p_doc_id and d.status = 'queued'
  returning * into v_doc;
  if not found then
    raise exception 'DTE % is not queued', p_doc_id using errcode = '22023';
  end if;

  update public.orders o
  set invoice_status = case when p_status = 'issued' then 'issued' else 'error' end
  where o.id = v_doc.order_id
  returning * into v_order;

  if p_status = 'issued' then
    perform public.log_order_event(v_order, 'invoice', v_order.status, null, null,
      jsonb_build_object('dte_id', v_doc.id, 'control_number', v_doc.control_number));
  end if;
  return v_doc;
end;
$$;
revoke execute on function public.finish_dte(uuid, text, text, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.finish_dte(uuid, text, text, timestamptz, jsonb, text) to service_role;

-- Service_role only: Hacienda accepted the invalidation event.
create or replace function public.mark_dte_invalidated(p_doc_id uuid, p_seal text)
returns public.dte_documents
language plpgsql
set search_path = ''
as $$
declare
  v_doc public.dte_documents;
begin
  update public.dte_documents d
  set status = 'invalidated', invalidated_at = now(), invalidation_seal = p_seal
  where d.id = p_doc_id and d.status = 'issued'
  returning * into v_doc;
  if not found then
    raise exception 'DTE % is not issued', p_doc_id using errcode = '22023';
  end if;
  update public.orders o set invoice_status = 'not_invoiced' where o.id = v_doc.order_id;
  return v_doc;
end;
$$;
revoke execute on function public.mark_dte_invalidated(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_dte_invalidated(uuid, text) to service_role;

-- ============================================================
-- Queue: invoice_status -> 'pending' enqueues; leaving it drops an unsent row
-- ============================================================
create or replace function public.enqueue_dte()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.invoice_status = 'pending' then
    if (select t.dte_enabled from public.tenants t where t.id = new.tenant_id)
      and not exists (select 1 from public.dte_documents d where d.order_id = new.id and d.status in ('queued', 'issued')) then
      insert into public.dte_documents (tenant_id, order_id) values (new.tenant_id, new.id);
    end if;
  elsif old.invoice_status = 'pending' and new.invoice_status = 'not_invoiced' then
    -- Admin correction out of delivered before anything reached Hacienda.
    delete from public.dte_documents d where d.order_id = new.id and d.status = 'queued' and d.attempts = 0;
  end if;
  return new;
exception when others then
  -- Anti-goal (spec §2): invoicing never blocks a status change.
  raise warning 'enqueue_dte failed for order %: %', new.id, sqlerrm;
  return new;
end;
$$;
revoke execute on function public.enqueue_dte() from public, anon, authenticated;

create trigger orders_enqueue_dte
  after update of invoice_status on public.orders
  for each row when (old.invoice_status is distinct from new.invoice_status)
  execute function public.enqueue_dte();

-- Operator/admin: send again after fixing the data (rejected / error), or
-- issue a new DTE after an invalidation. A rejected or failed row is requeued
-- as is (same numbers: Hacienda never accepted it; the sender asks Hacienda
-- first in case it did); an invalidated one gets a new row.
create or replace function public.retry_dte(p_order_id uuid)
returns public.dte_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_order public.orders;
  v_doc public.dte_documents;
begin
  if v_tenant_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.is_operator_or_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id and o.tenant_id = v_tenant_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if public.order_category(v_tenant_id, v_order.status) is distinct from 'delivered' then
    raise exception 'Solo se factura un pedido entregado.' using errcode = '22023';
  end if;
  if not (select t.dte_enabled from public.tenants t where t.id = v_tenant_id) then
    raise exception 'El DTE no está activado para esta empresa.' using errcode = '22023';
  end if;
  if exists (select 1 from public.dte_documents d where d.order_id = p_order_id and d.status in ('queued', 'issued')) then
    raise exception 'El pedido ya tiene una factura emitida o en cola.' using errcode = '22023';
  end if;

  select * into v_doc from public.dte_documents d
  where d.order_id = p_order_id and d.status in ('rejected', 'error')
  order by d.created_at desc limit 1;
  if found then
    update public.dte_documents d
    set status = 'queued', document = null, attempts = 0, next_attempt_at = now(), last_error = null
    where d.id = v_doc.id
    returning * into v_doc;
  else
    insert into public.dte_documents (tenant_id, order_id) values (v_tenant_id, p_order_id)
    returning * into v_doc;
  end if;
  -- The trigger sees the live row above and doesn't insert another.
  update public.orders o set invoice_status = 'pending' where o.id = p_order_id and o.invoice_status <> 'pending';
  return v_doc;
end;
$$;
revoke execute on function public.retry_dte(uuid) from public, anon;
grant execute on function public.retry_dte(uuid) to authenticated;

-- ============================================================
-- save_customers: + receptor location codes (copy of 20261102120000)
-- ============================================================
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

  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where nullif(r->>'id', '') is not null
    group by r->>'id'
    having count(*) > 1
  ) then
    raise exception 'Un cliente aparece dos veces en el guardado.' using errcode = '22023';
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

      -- The row skips validation: the checks below compare against the newer
      -- version, which this grid never saw.
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
          'department_code', v_current.department_code,
          'municipality_code', v_current.municipality_code,
          'district_code', v_current.district_code,
          'active', v_current.active,
          'updated_at', v_current.updated_at,
          'updated_by_name', (select u.name from public.users u where u.id = v_current.updated_by)
        );
        continue;
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

    -- Location codes (CAT-012/013/008): two digits each.
    if (v_row ? 'department_code' and nullif(btrim(coalesce(v_row->>'department_code', '')), '') !~ '^[0-9]{2}$')
      or (v_row ? 'municipality_code' and nullif(btrim(coalesce(v_row->>'municipality_code', '')), '') !~ '^[0-9]{2}$')
      or (v_row ? 'district_code' and nullif(btrim(coalesce(v_row->>'district_code', '')), '') !~ '^[0-9]{2}$') then
      raise exception 'La ubicación de "%" no es válida.', v_name using errcode = '22023';
    end if;

    v_rows := v_rows || v_row;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('saved', 0, 'conflicts', v_conflicts);
  end if;

  -- 2. Readable duplicate check (the unique index stays the real guard).
  with batch as materialized (
    select btrim(r->>'name') as name,
      public.normalize_name(r->>'name') as norm,
      nullif(r->>'id', '')::uuid as id
    from jsonb_array_elements(v_rows) r
  ),
  repeated as (
    select norm from batch group by norm having count(*) > 1
  ),
  taken as (
    select public.normalize_name(c.name) as norm
    from public.customers c
    where c.tenant_id = v_tenant_id
      and c.id not in (select id from batch where id is not null)
  )
  select string_agg(distinct b.name, ', ')
  into v_dupes
  from batch b
  where b.norm in (select norm from repeated)
    or b.norm in (select norm from taken);

  if v_dupes is not null then
    raise exception 'Ya existe: %', v_dupes using errcode = '23505';
  end if;

  -- 3. Write. Only keys present are updated (panel fields survive a grid save).
  begin
    -- Renamed rows give up their name first (see save_products()).
    update public.customers c
    set name = gen_random_uuid()::text
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
          cod_actividad, desc_actividad, email, active,
          department_code, municipality_code, district_code
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
          coalesce((v_row->>'active')::boolean, true),
          nullif(btrim(coalesce(v_row->>'department_code', '')), ''),
          nullif(btrim(coalesce(v_row->>'municipality_code', '')), ''),
          nullif(btrim(coalesce(v_row->>'district_code', '')), '')
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
            department_code = case when v_row ? 'department_code' then nullif(btrim(coalesce(v_row->>'department_code', '')), '') else c.department_code end,
            municipality_code = case when v_row ? 'municipality_code' then nullif(btrim(coalesce(v_row->>'municipality_code', '')), '') else c.municipality_code end,
            district_code = case when v_row ? 'district_code' then nullif(btrim(coalesce(v_row->>'district_code', '')), '') else c.district_code end,
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
-- Customer email with the DTE (delivering it to the receptor is mandatory)
-- ============================================================
alter table public.order_notifications drop constraint order_notifications_kind_check;
alter table public.order_notifications add constraint order_notifications_kind_check check (kind in (
  'received', 'confirmed', 'rescheduled', 'on_the_way',
  'delivered', 'partially_delivered', 'failed', 'cancelled', 'invoice_issued'
));

-- Same as 20261106100000, plus 'invoice': sent whenever the customer has an
-- email, regardless of customer_email_actions (the law requires it).
create or replace function public.enqueue_customer_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actions text[];
  v_email text;
  v_kind text;
begin
  select coalesce(
    (select s.customer_email_actions from public.tenant_order_settings s where s.tenant_id = new.tenant_id),
    '{create,assign,pick_up,deliver,fail,cancel}'
  ) into v_actions;
  if new.action <> 'invoice' and not (new.action = any (v_actions)) then
    return new;
  end if;

  select nullif(btrim(c.email), '') into v_email
  from public.orders o join public.customers c on c.id = o.customer_id
  where o.id = new.order_id;
  if v_email is null then
    return new;
  end if;

  v_kind := case new.action
    when 'create' then 'received'
    -- Only a first confirmation or a reprogram tells the customer something;
    -- a reassignment (confirmed/accepted -> confirmed) does not.
    when 'assign' then (
      select case s.step when 'created' then 'confirmed' when 'delivery_failed' then 'rescheduled' end
      from public.order_statuses s
      where s.tenant_id = new.tenant_id and s.key = new.from_status
    )
    when 'pick_up' then 'on_the_way'
    when 'deliver' then case when (new.payload ->> 'partial')::boolean then 'partially_delivered' else 'delivered' end
    when 'fail' then 'failed'
    when 'cancel' then 'cancelled'
    when 'invoice' then 'invoice_issued'
  end;
  if v_kind is null then
    return new;
  end if;

  insert into public.order_notifications (tenant_id, order_id, event_id, kind, recipient)
  values (new.tenant_id, new.order_id, new.id, v_kind, v_email);
  return new;
exception when others then
  -- Anti-goal (spec §2): an email problem never blocks a status change.
  raise warning 'enqueue_customer_email failed for event %: %', new.id, sqlerrm;
  return new;
end;
$$;

-- ============================================================
-- Public invoice page data (/t/<token>/factura): the representación gráfica
-- ============================================================
-- No expiry: the receptor keeps the right to see its DTE. The latest issued
-- (or invalidated, shown as such) DTE of the order; null = none.
create or replace function public.get_order_invoice(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', d.status,
    'document', d.document,
    'reception_seal', d.reception_seal,
    'processed_at', d.processed_at,
    'invalidated_at', d.invalidated_at
  )
  from public.orders o
  join public.dte_documents d on d.order_id = o.id and d.status in ('issued', 'invalidated')
  where p_token is not null and char_length(p_token) = 64 and o.tracking_token = p_token
  order by d.created_at desc
  limit 1
$$;
revoke execute on function public.get_order_invoice(text) from public;
grant execute on function public.get_order_invoice(text) to anon, authenticated;

-- ============================================================
-- Backlog: delivered orders whose DTE isn't issued yet
-- ============================================================
-- The safety net for "a DTE never reached Hacienda and nobody noticed": the
-- /orders/facturas list, the banner on /orders and the admins' daily email
-- all read this. A delivered order of a tenant with DTE on shows up if its
-- DTE failed, is still queued, or was never queued (enqueue_dte swallows its
-- errors) when delivered after DTE was turned on. stuck = needs a person:
-- failed, or not issued 1 hour after (5 attempts take ~1 hour; a cron that
-- stopped running shows up here too).
create or replace function public.dte_backlog_for(p_tenant_id uuid)
returns table (
  order_id uuid, tenant_id uuid, customer_name text, invoice_status text,
  dte_status text, last_error text, since timestamptz, stuck boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.tenant_id, c.name, o.invoice_status, d.status, d.last_error, s.since,
    o.invoice_status = 'error' or s.since < now() - interval '1 hour'
  from public.orders o
  join public.tenants t on t.id = o.tenant_id and t.dte_enabled
  left join public.customers c on c.id = o.customer_id
  left join lateral (
    select d.status, d.last_error, d.created_at from public.dte_documents d
    where d.order_id = o.id order by d.created_at desc limit 1
  ) d on true
  left join lateral (
    select max(dl.created_at) as delivered_at from public.order_deliveries dl
    where dl.order_id = o.id and dl.outcome <> 'failed'
  ) dl on true
  cross join lateral (select coalesce(d.created_at, dl.delivered_at, o.created_at) as since) s
  where o.invoice_status in ('pending', 'error')
    and (p_tenant_id is null or o.tenant_id = p_tenant_id)
    and (d.status is not null or coalesce(dl.delivered_at, o.created_at) >= t.dte_enabled_at)
  order by s.since
$$;
revoke execute on function public.dte_backlog_for(uuid) from public, anon, authenticated;
grant execute on function public.dte_backlog_for(uuid) to service_role;

-- Operator/admin: their own tenant's backlog.
create or replace function public.dte_backlog()
returns table (
  order_id uuid, tenant_id uuid, customer_name text, invoice_status text,
  dte_status text, last_error text, since timestamptz, stuck boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.dte_backlog_for(public.tenant_id())
  where public.tenant_id() is not null and public.is_operator_or_admin()
$$;
revoke execute on function public.dte_backlog() from public, anon;
grant execute on function public.dte_backlog() to authenticated;

-- Service_role (daily email): tenants with stuck DTEs and their active admins' emails.
create or replace function public.dte_backlog_alerts()
returns table (tenant_id uuid, tenant_name text, admin_emails text[], stuck int)
language sql
stable
security definer
set search_path = ''
as $$
  select b.tenant_id, coalesce(t.commercial_name, t.name),
    array(
      select au.email from public.users u join auth.users au on au.id = u.id
      where u.tenant_id = b.tenant_id and u.role = 'admin' and au.email is not null
        and (au.banned_until is null or au.banned_until < now())
    ),
    count(*)::int
  from public.dte_backlog_for(null) b
  join public.tenants t on t.id = b.tenant_id
  where b.stuck
  group by b.tenant_id, t.commercial_name, t.name
$$;
revoke execute on function public.dte_backlog_alerts() from public, anon, authenticated;
grant execute on function public.dte_backlog_alerts() to service_role;
