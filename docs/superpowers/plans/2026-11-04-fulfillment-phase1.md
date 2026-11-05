# Fulfillment fase 1 (chofer y estados) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada paso del pedido lo marca quien lo vive: la oficina confirma y asigna chofer, el chofer acepta, recoge y entrega con firma desde su celular, y el estado deja de poder cambiarse a mano (salvo la corrección del admin).

**Architecture:** Categorías y `step` fijos en el código; los estados de cada empresa viven en `order_statuses` (sembrados por empresa). Todo cambio de estado pasa por funciones `security definer` que validan rol, tenant, estado esperado y transición, y escriben `order_events`. Los cambios directos por PostgREST se cierran con privilegios por columna y un trigger de bloqueo de edición. El chofer lee por RLS solo sus pedidos y por RPC los datos del cliente; sube firma y foto a un bucket privado.

**Tech Stack:** Supabase (Postgres 17, RLS, Storage, Realtime), Next.js App Router + Server Actions, TypeScript, Vitest (integración contra Supabase local), shadcn/ui + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-11-04-order-fulfillment-e2e-design.md` (fase 1 de §13). Leer también `CLAUDE.md` (ADR-009, ADR-010, §7) y `DESIGN.md` antes de cualquier UI.

## Global Constraints

- Código y SQL en inglés; textos de la interfaz en español.
- Categorías fijas: `to_confirm`, `preparing`, `in_transit`, `delivered`, `cancelled`.
- Steps fijos: `created`, `confirmed`, `accepted`, `picked_up`, `delivery_failed`, `delivered`, `partially_delivered`, `cancelled`.
- Estados ECTEC (clave → nombre → categoría → step): `pending` Pedido / to_confirm / created · `confirmed` Confirmado / preparing / confirmed · `accepted` Aceptado por chofer / preparing / accepted · `dispatched` En camino / in_transit / picked_up · `delivery_failed` Entrega fallida / in_transit / delivery_failed · `delivered` Entregado / delivered / delivered · `partially_delivered` Entregado parcial / delivered / partially_delivered · `cancelled` Cancelado / cancelled / cancelled.
- Interruptores por empresa, valores por defecto (ECTEC): `require_driver_acceptance = true`, `require_signature = true`, `require_receiver_name = true`, `require_photo = false`.
- Toda política usa `(select public.tenant_id())` (ADR-009). Toda función nueva: `set search_path = ''`.
- Funciones de transición: `security definer`, chequeo explícito de `public.tenant_id()` no nulo y `order.tenant_id = public.tenant_id()` (definer salta RLS).
- Códigos de error: `28000` sin sesión · `42501` rol no permitido · `P0002` pedido no encontrado o de otro tenant/chofer · `PT409` el estado ya no es el esperado · `22023` transición o dato inválido · `22004` falta un dato obligatorio.
- Edición del pedido (líneas, precios, cliente, notas) permitida hasta step `accepted`; bloqueada en categorías `in_transit`, `delivered`, `cancelled`.
- Cancelar: desde steps `created`, `confirmed`, `accepted`, `delivery_failed`, con motivo obligatorio.
- Corrección manual: solo `admin`, motivo obligatorio, cualquier estado destino; prohibido sacar de `delivered` si `invoice_status = 'issued'`.
- Motivos de entrega fallida y cancelación: `customer_closed` "Cliente cerrado", `customer_refused` "Cliente rechazó", `wrong_address` "Dirección incorrecta", `other` "Otro" (con texto obligatorio).
- Motivos de faltante por línea: `refused` "No lo quiso", `damaged` "Venía dañado", `short` "No alcanzó", `other` "Otro".
- Métodos de cobro: `cash` Efectivo, `check` Cheque, `transfer` Transferencia, `credit` Crédito.
- El chofer ve productos, cantidades y total a cobrar; nunca precios por línea ni estadísticas. Del cliente: nombre, dirección y teléfono. Pedidos: activos + cerrados en los últimos 7 días.
- Realtime: solo INSERT/UPDATE, sin `REPLICA IDENTITY FULL` (ADR-010).
- Tipos: tras cada migración, `supabase gen types typescript --local > lib/supabase/database.types.ts`.
- Commits sin trailer `Co-Authored-By`.

## Review Focus

1. **Reintento de la entrega** (el celular reenvía `record_delivery` con el mismo `p_delivery_id` tras un timeout): debe devolver el mismo resultado sin duplicar eventos ni fallar. → Task 5, test `retry with the same delivery id is a no-op`.
2. **Cantidades entregadas raras** (negativas, `NaN`, mayores a lo pedido, de una línea de otro pedido): se rechazan con `22023`. → Task 5, test `rejects bad delivered quantities`.
3. **Ruta de firma ajena** (el chofer manda `signature_path` de otro tenant o de otra entrega): se rechaza. → Task 5, test `rejects proof paths outside tenant/delivery`.
4. **Chofer desactivado** (baneado) o de otro tenant, o un usuario que no es chofer: no se le puede asignar. → Task 3, test `assign rejects inactive, foreign or non-driver users`.
5. **Carrera cancelar vs recoger**: el operador cancela mientras el chofer toca "Recogido": gana el primero y el segundo recibe `PT409`/`22023`, nunca un pedido cancelado en camino. → Task 4, test `pick up of an order cancelled meanwhile is rejected`.

---

### Task 1: Modelo de estados, configuración, historial y columnas nuevas

**Files:**
- Create: `supabase/migrations/20261105100000_fulfillment_model.sql`
- Modify: `lib/supabase/database.types.ts` (regenerado)
- Test: `tests/fulfillment-model.test.ts`

**Interfaces:**
- Produces (SQL):
  - `public.order_statuses (tenant_id uuid, key text, label text, category text, step text null, position int, primary key (tenant_id, key))`, checks sobre `category` y `step` con los valores de Global Constraints; único `(tenant_id, step)` donde `step is not null`.
  - `public.seed_order_statuses(p_tenant_id uuid) returns void` (los 8 de ECTEC) + trigger `after insert on public.tenants` que la llama; backfill para tenants existentes.
  - `public.tenant_order_settings (tenant_id uuid primary key, require_driver_acceptance bool not null default true, require_signature bool not null default true, require_receiver_name bool not null default true, require_photo bool not null default false)`, sembrada por el mismo trigger.
  - `public.order_status_for_step(p_tenant_id uuid, p_step text) returns text` (clave del estado; `22023` si la empresa no tiene ese step).
  - `public.order_category(p_tenant_id uuid, p_status text) returns text` (stable).
  - `orders`: FK `(tenant_id, status) → order_statuses(tenant_id, key)` (se quita `orders_status_check`); `driver_id uuid null` con FK compuesta `(tenant_id, driver_id) → users(tenant_id, id)` (agregar `unique (tenant_id, id)` en `users`); `delivery_date date null`; `delivery_window text null` (≤ 100); `status_changed_at timestamptz not null default now()`; `invoice_status text not null default 'not_invoiced'` check en (`not_invoiced`, `pending`, `issued`, `error`). Índice `(tenant_id, driver_id)`.
  - `order_items`: `delivered_quantity numeric(10,2) null` (≥ 0, ≠ NaN, ≤ `quantity`), `shortfall_reason text null` check en los motivos de faltante, `shortfall_note text null` (≤ 200).
  - `public.order_events (id uuid pk default gen_random_uuid(), tenant_id uuid not null, order_id uuid not null references orders on delete cascade, action text not null, from_status text null, to_status text not null, actor_id uuid null references users on delete set null, reason text null, note text null, payload jsonb not null default '{}', created_at timestamptz not null default now())`, índice `(tenant_id, order_id, created_at)`. Valores de `action`: `create`, `assign`, `reject`, `accept`, `pick_up`, `deliver`, `fail`, `cancel`, `correct`.
  - `public.log_order_event(p_order public.orders, p_action text, p_from text, p_reason text, p_note text, p_payload jsonb) returns void` (security definer, interno; `revoke execute ... from public, anon, authenticated`).
  - `create_order()` existente pasa a escribir un evento `create`.
  - RLS: `order_statuses` y `tenant_order_settings` select para todo rol del tenant; `order_events` select operador/admin; ninguna política de insert/update/delete en las tres.

- [ ] **Step 1: Write the failing tests** en `tests/fulfillment-model.test.ts` con `setupTenant()`:
  - `seeds the 8 ECTEC statuses and default settings for a new tenant`: `admin.from("order_statuses").select()` devuelve las 8 claves con categoría/step/posición de Global Constraints; `tenant_order_settings` trae los 4 valores por defecto.
  - `a new order starts in the created step and logs a create event`: `createOrder()` → `status = 'pending'`, `invoice_status = 'not_invoiced'`, un `order_events` con `action = 'create'`, `actor_id = operatorId`.
  - `status must exist for the tenant`: `service` actualizando `status = 'nope'` falla con FK (`23503`).
  - `no role can write statuses, settings or events directly`: insert/update en las tres tablas como admin → error o 0 filas.
  - `driver cannot read order_events; other tenant sees nothing`.
- [ ] **Step 2: Run** `pnpm vitest run tests/fulfillment-model.test.ts` → FAIL (tablas no existen).
- [ ] **Step 3: Write the migration** con lo de Interfaces. `delivered_quantity` y las columnas nuevas de `orders` quedan sin escritura directa (Task 2 cierra los privilegios).
- [ ] **Step 4: Apply and regenerate** `supabase migration up && supabase gen types typescript --local > lib/supabase/database.types.ts`.
- [ ] **Step 5: Run** `pnpm test` → todo PASS (las suites existentes siguen verdes: las claves viejas no cambian).
- [ ] **Step 6: Commit** `feat(orders): per-tenant order statuses with fixed categories and steps, settings, event log`

### Task 2: Cerrar los cambios directos y bloquear la edición

**Files:**
- Create: `supabase/migrations/20261105110000_fulfillment_locks.sql`
- Modify: `tests/rls.test.ts` (la fila "operator/admin update orders.status" pasa a denegada)
- Test: `tests/fulfillment-locks.test.ts`

**Interfaces:**
- Consumes: `order_category()` (Task 1).
- Produces:
  - Privilegios: `revoke insert, update on public.orders from authenticated, anon`; `grant insert (tenant_id, customer_id, notes, channel)` y `grant update (customer_id, notes)` a `authenticated`. `revoke update on public.order_items from authenticated, anon`; `grant update (product_id, quantity, price_at_order, unit_at_order)`. Ajustar la lista si `pnpm test` muestra otra columna que escribe una función invoker existente (`create_order`, `update_order_detail`); no ampliar más allá de eso.
  - Trigger `orders_edit_lock` (before update of customer_id, notes) y `order_items_edit_lock` (before insert, update of product_id/quantity/price_at_order/unit_at_order, delete): con `auth.uid()` no nulo y `pg_trigger_depth() = 1`, si la categoría del pedido es `in_transit`, `delivered` o `cancelled` → `22023` "El pedido ya salió; no se puede editar."
  - Trigger `order_items_touch_order` (after insert/update en `order_items`): actualiza `orders.updated_at` del pedido para que el chofer reciba el evento Realtime (no tiene política sobre `order_items`).

- [ ] **Step 1: Write the failing tests** en `tests/fulfillment-locks.test.ts`:
  - `operator cannot change status, driver_id, invoice_status or status_changed_at directly` (PATCH → `42501`).
  - `operator cannot insert an order with a status or driver` (insert con `status: 'delivered'` → `42501`).
  - `operator cannot write delivered_quantity directly`.
  - `edits allowed until accepted, rejected from in_transit on`: con `tenant.service` poner el pedido en `accepted` → `updateOrderDetail()` OK; en `dispatched`, `delivered`, `cancelled` → `22023`; insertar/borrar línea en `dispatched` → `22023`.
  - `editing an item bumps the order's updated_at`.
- [ ] **Step 2: Run** `pnpm vitest run tests/fulfillment-locks.test.ts` → FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Update `tests/rls.test.ts`**: la operación UPDATE de `orders` se prueba sobre `notes` (sigue permitida para operador/admin, denegada a driver); agregar caso de `status` denegado para los tres roles.
- [ ] **Step 5: Run** `pnpm test` → falla solo `tests/orders-kanban.test.ts` / `tests/orders-realtime.test.ts` donde usan `updateOrderStatus()`; marcarlos con `it.todo` apuntando a Task 6 (se reescriben ahí). Todo lo demás PASS.
- [ ] **Step 6: Commit** `fix(orders): status and delivery columns only change through server functions; edits lock once the order leaves`

### Task 3: Acciones de la oficina (asignar, cancelar, corregir)

**Files:**
- Create: `supabase/migrations/20261105120000_office_transitions.sql`
- Test: `tests/office-transitions.test.ts`

**Interfaces:**
- Consumes: `order_status_for_step()`, `order_category()`, `log_order_event()` (Task 1).
- Produces (todas `security definer`, devuelven `public.orders`):
  - `assign_order(p_order_id uuid, p_driver_id uuid, p_delivery_date date, p_delivery_window text, p_expected_status text) returns public.orders` — operador/admin. Desde step `created` (confirmar), `confirmed`/`accepted` (reasignar) o `delivery_failed` (reprogramar) → step `confirmed`. Chofer obligatorio: `users.role = 'driver'`, mismo tenant, no baneado (`auth.users.banned_until` nulo o pasado). `p_delivery_date` obligatoria; `p_delivery_window` opcional (≤ 100). Acción del evento: `assign`; `payload = {driver_id, delivery_date, delivery_window, previous_driver_id}`. Actualiza `status_changed_at`.
  - `cancel_order(p_order_id uuid, p_reason text, p_note text, p_expected_status text) returns public.orders` — operador/admin, desde los steps de Global Constraints; `p_reason` en la lista de motivos, `p_note` obligatoria si `other`. Deja `driver_id` como estaba (el chofer deja de verlo por categoría).
  - `correct_order_status(p_order_id uuid, p_status text, p_reason text, p_expected_status text) returns public.orders` — solo admin, `p_reason` texto libre obligatorio. Si el destino es categoría `delivered` sin entrega registrada → `payload.without_signature = true` e `invoice_status = 'pending'`. Si sale de `delivered`: `issued` → `22023`; `pending` → `not_invoiced`.
  - `list_tenant_drivers() returns table (id uuid, name text, active boolean)` — operador/admin.
  - Todas: `p_expected_status` distinto del actual → `PT409`; pedido inexistente o de otro tenant → `P0002`; transición no permitida → `22023`.

- [ ] **Step 1: Write the failing tests** en `tests/office-transitions.test.ts`:
  - `confirm assigns driver and window, logs assign`: `assign_order` desde `pending` → `confirmed`, `driver_id = driverId`, evento con payload.
  - `reassign and reprogram go back to confirmed`: desde `accepted` y desde `delivery_failed` (puesto con `service`) → `confirmed` con el chofer nuevo.
  - `assign rejects inactive, foreign or non-driver users` (Review Focus 4): chofer baneado vía `service.auth.admin.updateUserById(id, { ban_duration: "24h" })`, chofer de otro tenant, `operatorId` → `22023`.
  - `assign from dispatched or delivered is rejected` → `22023`.
  - `stale expected status is PT409`.
  - `driver cannot call office actions` → `42501`.
  - `cancel needs a reason, and other needs a note; not allowed in transit or delivered`.
  - `admin correction: any state with reason, operator denied, delivered without proof marks without_signature and pending invoice, issued invoice blocks leaving delivered`.
  - `list_tenant_drivers returns only this tenant's drivers with active flag`.
- [ ] **Step 2: Run** `pnpm vitest run tests/office-transitions.test.ts` → FAIL.
- [ ] **Step 3: Write the migration.** Bloquear la fila con `select ... for update` antes de comparar el estado esperado.
- [ ] **Step 4: Regenerate types; run** `pnpm vitest run tests/office-transitions.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(orders): confirm with driver and window, reassign, reprogram, cancel with reason, admin correction`

### Task 4: El chofer ve sus pedidos, acepta, rechaza y recoge

**Files:**
- Create: `supabase/migrations/20261105130000_driver_orders.sql`
- Test: `tests/driver-orders.test.ts`
- Modify: `tests/orders-realtime.test.ts` (nuevo caso de aislamiento entre choferes)

**Interfaces:**
- Consumes: Task 1, Task 3 (`assign_order` para preparar los pedidos en los tests).
- Produces:
  - Política `orders_select_own_driver` (select): `tenant_id = (select public.tenant_id())` y `public.role() = 'driver'` y `driver_id = auth.uid()` y (categoría en `preparing`/`in_transit`, o categoría en `delivered`/`cancelled` con `status_changed_at > now() - interval '7 days'`). Sin políticas nuevas en `order_items` ni `customers`.
  - `respond_to_assignment(p_order_id uuid, p_accept boolean, p_expected_status text) returns public.orders` — chofer asignado, desde step `confirmed`. Aceptar → `accepted` (evento `accept`). Rechazar → sigue `confirmed` con `driver_id = null` (evento `reject`, payload `{driver_id}`).
  - `pick_up_orders(p_order_ids uuid[]) returns setof public.orders` — chofer asignado; cada pedido en step `accepted`, o en `confirmed` si `require_driver_acceptance = false`; → `picked_up`, evento `pick_up`. Todo o nada; bloquea las filas en orden de id.
  - `list_driver_orders() returns jsonb` — chofer. Arreglo de `{id, status, status_label, category, delivery_date, delivery_window, notes, status_changed_at, customer: {name, address, phone}, items: [{id, product_name, quantity, unit, delivered_quantity}], total, attempt}` para los mismos pedidos que la política. `total` = suma de `quantity × price_at_order` (null si alguna línea no tiene precio); `attempt` = cantidad de eventos `pick_up` del pedido. Sin `price_at_order` por línea.

- [ ] **Step 1: Write the failing tests** en `tests/driver-orders.test.ts` (crear un segundo chofer en el mismo tenant con el helper de creación de usuarios que usan `tests/create-user.test.ts`):
  - `driver sees only orders assigned to them` (select directo y `list_driver_orders`).
  - `driver list has customer address/phone and total, no line prices` (`items[0]` no tiene `price_at_order`).
  - `closed orders stay visible 7 days` (con `service`, `status_changed_at` a hace 8 días → desaparece).
  - `driver still cannot read customers or order_items directly`.
  - `accept → accepted; reject → confirmed without driver, operator sees reject event`.
  - `a driver cannot respond for another driver's order` → `P0002`.
  - `pick up several at once, all or nothing` (uno de los ids sin aceptar → ninguno cambia).
  - `pick up without acceptance when the tenant turns it off` (cambiar setting con `service`).
  - `pick up of an order cancelled meanwhile is rejected` (Review Focus 5).
- [ ] **Step 2: Add to `tests/orders-realtime.test.ts`**: `a driver gets events only for their own orders` (asignar a chofer A, el chofer B no recibe nada).
- [ ] **Step 3: Run** ambos archivos → FAIL.
- [ ] **Step 4: Write the migration**; regenerate types.
- [ ] **Step 5: Run** ambos archivos → PASS.
- [ ] **Step 6: Commit** `feat(orders): drivers see their own orders, accept or reject, pick up in batch`

### Task 5: Entrega con prueba (firma, nombre, foto, cobro), parcial y fallida

**Files:**
- Create: `supabase/migrations/20261105140000_record_delivery.sql`
- Test: `tests/record-delivery.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 4.
- Produces:
  - `public.order_deliveries (id uuid primary key, tenant_id uuid not null, order_id uuid not null references orders on delete cascade, driver_id uuid null references users on delete set null, outcome text not null check in ('delivered','partially_delivered','failed'), receiver_name text null (≤ 200), signature_path text null, photo_path text null, failure_reason text null, failure_note text null (≤ 200), payment_method text null check en los métodos, amount_collected numeric(10,2) null (≥ 0, ≠ NaN), created_at timestamptz not null default now())`. El `id` lo genera el celular. RLS: select operador/admin del tenant; sin escritura directa.
  - Bucket privado `delivery-proofs` (por migración). Rutas `{tenant_id}/{delivery_id}/signature.png` y `{tenant_id}/{delivery_id}/photo.jpg`. Políticas de `storage.objects`: insert para chofer cuando el primer segmento es su `tenant_id`; select para operador/admin del tenant y para el chofer que subió el objeto (`owner = auth.uid()`). Sin update ni delete.
  - `record_delivery(p_delivery_id uuid, p_order_id uuid, p_outcome text, p_lines jsonb, p_receiver_name text, p_signature_path text, p_photo_path text, p_failure_reason text, p_failure_note text, p_payment_method text, p_amount_collected numeric) returns jsonb` — chofer asignado, pedido en step `picked_up`.
    - Si ya existe `order_deliveries.id = p_delivery_id` del mismo pedido y chofer → devuelve `{order, delivery}` sin escribir nada.
    - `p_outcome = 'failed'`: `p_failure_reason` obligatorio (nota si `other`); → step `delivery_failed`, evento `fail`.
    - `p_outcome = 'delivered'`: `p_lines` = `[{order_item_id, delivered_quantity, reason?, note?}]` con todas las líneas del pedido; `0 ≤ delivered_quantity ≤ quantity`, no `NaN`; línea por debajo de lo pedido exige `reason`. Todas en cero → `22023` ("usa No se pudo entregar"). Alguna por debajo → step `partially_delivered`, si no `delivered`. Escribe `order_items.delivered_quantity/shortfall_*`, `invoice_status = 'pending'`, evento `deliver` con `payload {delivery_id, partial}`.
    - Requisitos según `tenant_order_settings`: firma, nombre, foto (solo para entregas, no para fallidas). Cada ruta debe empezar con `{tenant_id}/{p_delivery_id}/` y existir en `storage.objects` del bucket → si no, `22023`.
    - `p_payment_method` opcional; `p_amount_collected` solo con método distinto de `credit`.

- [ ] **Step 1: Write the failing tests** en `tests/record-delivery.test.ts` (subir firma/foto con `tenant.driver.storage.from("delivery-proofs").upload(...)` y un PNG de 1×1):
  - `full delivery with signature and name → delivered, invoice pending, proof readable by operator`.
  - `missing signature or receiver name is rejected; photo required only when the setting is on`.
  - `partial delivery stores delivered quantities and reasons → partially_delivered`.
  - `all lines at zero is rejected`.
  - `rejects bad delivered quantities` (Review Focus 2): negativa, `NaN`, mayor a lo pedido, `order_item_id` de otro pedido, línea faltante.
  - `rejects proof paths outside tenant/delivery` (Review Focus 3).
  - `failed delivery needs a reason → delivery_failed; office can reprogram it` (`assign_order` lo devuelve a `confirmed`; `list_driver_orders().attempt` = 2 tras el segundo `pick_up`).
  - `retry with the same delivery id is a no-op` (Review Focus 1): segunda llamada igual → mismo resultado, un solo evento `deliver`.
  - `driver cannot upload under another tenant's folder; operator of another tenant cannot read`.
  - `only the assigned driver, only from picked_up`.
- [ ] **Step 2: Run** `pnpm vitest run tests/record-delivery.test.ts` → FAIL.
- [ ] **Step 3: Write the migration**; regenerate types.
- [ ] **Step 4: Run** → PASS; luego `pnpm test` completo.
- [ ] **Step 5: Commit** `feat(orders): delivery with signature, receiver, photo and payment; partial and failed deliveries`

### Task 6: Capa TypeScript, estadísticas y tablero por categoría

**Files:**
- Create: `lib/orders/fulfillment.ts` (constantes y lógica pura), `lib/orders/actions-client.ts` (envoltorios de las RPCs)
- Create: `supabase/migrations/20261105150000_stats_by_category.sql`
- Modify: `lib/order-math.ts` (quitar `ORDER_STATUSES`, `ORDER_STATUS_LABELS`, `nextStatusAction`, `applyPendingMoves` si ya no se usan; dejar la matemática de totales), `lib/supabase/queries.ts` (`listOrdersForKanban`, quitar `updateOrderStatus`, `getOrderDetail` con campos nuevos)
- Test: `tests/fulfillment-lib.test.ts`; reescribir `tests/orders-kanban.test.ts`, `tests/today-stats.test.ts`, `tests/order-math.test.ts`, los `it.todo` de `tests/orders-realtime.test.ts`

**Interfaces:**
- Produces:
  - `lib/orders/fulfillment.ts`: `ORDER_CATEGORIES`, `ORDER_STEPS`, `type OrderCategory`, `type OrderStep`, `interface OrderStatusDef { key: string; label: string; category: OrderCategory; step: OrderStep | null; position: number }`, `FAILURE_REASONS`, `SHORTFALL_REASONS`, `PAYMENT_METHODS` (clave → etiqueta en español, de Global Constraints), `canOfficeDrag(from: OrderStatusDef, to: OrderStatusDef): boolean` (solo `created → confirmed`), `isEditable(status: OrderStatusDef): boolean`, `canCancel(status: OrderStatusDef): boolean`, `hoursSince(iso: string, now: Date): number`.
  - `lib/supabase/queries.ts`: `listOrderStatuses(supabase): Promise<QueryResult<OrderStatusDef[]>>`; `KanbanOrder` gana `driverName: string | null`, `deliveryDate: string | null`, `deliveryWindow: string | null`, `statusChangedAt: string`, `attempt: number`; `listOrdersForKanban` trae categorías `to_confirm`/`preparing`/`in_transit` sin límite y `delivered` con límite 50; `cancelled` no va al tablero. `OrderDetail` gana `driver`, `deliveryDate`, `deliveryWindow`, `invoiceStatus`, `events: { action, fromStatus, toStatus, actorName, reason, note, createdAt }[]`, `delivery: { receiverName, signatureUrl, photoUrl, paymentMethod, amountCollected, createdAt, outcome, failureReason, failureNote } | null` (URLs firmadas de 1 h).
  - `lib/orders/actions-client.ts`: `assignOrder`, `cancelOrder`, `correctOrderStatus`, `listTenantDrivers`, `respondToAssignment`, `pickUpOrders`, `listDriverOrders`, `recordDelivery`, `uploadDeliveryProof(supabase, tenantId, deliveryId, kind: "signature" | "photo", file: Blob): Promise<QueryResult<string>>`; cada una `(supabase: Client, …params de la RPC en camelCase) → Promise<QueryResult<…>>`, mismo estilo que `queries.ts`.
  - `get_today_stats()` cuenta `pending` como categoría `to_confirm` y `delivered` como categoría `delivered`.

- [ ] **Step 1: Write `tests/fulfillment-lib.test.ts`** (pura): `canOfficeDrag` true solo para created→confirmed; `isEditable` true en created/confirmed/accepted y false en picked_up/delivery_failed/delivered/partially_delivered/cancelled; `canCancel` según Global Constraints; `hoursSince`.
- [ ] **Step 2: Rewrite `tests/orders-kanban.test.ts`** sobre `listOrdersForKanban` (campos nuevos, cancelados fuera, entregados con límite) y `assignOrder` desde el tablero; `tests/today-stats.test.ts` con un pedido `partially_delivered` que cuenta como entregado; `tests/orders-realtime.test.ts` usando `assignOrder` en vez de `updateOrderStatus`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** lo de Interfaces y la migración de estadísticas.
- [ ] **Step 5: Run** `pnpm test && pnpm tsc --noEmit && pnpm lint` → PASS.
- [ ] **Step 6: Commit** `refactor(orders): board, stats and helpers driven by categories and steps`

### Task 7: Tablero de la oficina

**Files:**
- Modify: `components/orders/orders-kanban.tsx`, `components/orders/kanban-column.tsx`, `components/orders/order-card.tsx`, `components/orders/orders-mobile-board.tsx`, `components/orders/order-status-badge.tsx`, `components/orders/orders-page-content.tsx`
- Create: `components/orders/assign-order-panel.tsx`

**Interfaces:**
- Consumes: `listOrderStatuses`, `listOrdersForKanban`, `canOfficeDrag`, `hoursSince`, `assignOrder`, `listTenantDrivers` (Task 6). `FormPanel` existente para el panel.
- Produces: `AssignOrderPanel({ order, mode: "confirm" | "reassign" | "reprogram", expectedStatus, onDone })` (lo reutiliza Task 8).

- [ ] **Step 1: Columnas** = estados del tenant ordenados por `position`, sin `cancelled`. El color del badge sale de la categoría (reusar los tokens `--status-*` de DESIGN.md: `to_confirm` pending, `preparing` confirmed, `in_transit` dispatched, `delivered` delivered; `delivery_failed` y `partially_delivered` con su propia marca de aviso según DESIGN.md).
- [ ] **Step 2: Arrastrar** solo cuando `canOfficeDrag`; las demás columnas no aceptan soltar. Soltar en Confirmado abre `AssignOrderPanel` (chofer del listado de `listTenantDrivers`, solo activos; fecha obligatoria, hoy por defecto; ventana opcional). Cerrar sin guardar deja la tarjeta en Pedido. `PT409` → mensaje "Alguien cambió este pedido" y recarga.
- [ ] **Step 3: Tarjeta**: chofer, fecha y ventana; "Sin aceptar desde hace N h" cuando el step es `confirmed` y `hoursSince(statusChangedAt) ≥ 1`; "Intento N" cuando `attempt ≥ 2`; aviso visible en `delivery_failed`.
- [ ] **Step 4: Teléfono**: el botón de siguiente paso existe solo en Pedido ("Confirmar", abre el panel); se quitan "Mover a…" y la barra de deshacer.
- [ ] **Step 5: Verify** `pnpm tsc --noEmit && pnpm lint && pnpm test`; luego `/qa` en `/orders` (escritorio y 375 px): confirmar con chofer, intento de arrastrar a En camino (no deja), tarjeta de un pedido que el chofer aceptó en otra sesión se mueve sola.
- [ ] **Step 6: Commit** `feat(orders): board shows driver states read-only; confirming opens the driver and window panel`

### Task 8: Detalle del pedido en la oficina

**Files:**
- Modify: `components/orders/order-detail-panel.tsx`
- Create: `components/orders/order-timeline.tsx`, `components/orders/delivery-proof.tsx`, `components/orders/cancel-order-dialog.tsx`, `components/orders/correct-status-dialog.tsx`

**Interfaces:**
- Consumes: `getOrderDetail` (Task 6), `AssignOrderPanel` (Task 7), `cancelOrder`, `correctOrderStatus`, `isEditable`, `canCancel`, `createOrder` (existente).

- [ ] **Step 1: Edición**: los campos editables se deshabilitan cuando `!isEditable(status)`, con el texto "El pedido ya salió; no se puede editar." (el servidor ya lo prohíbe).
- [ ] **Step 2: Acciones** según estado: "Reasignar" (confirmed/accepted), "Reprogramar" (delivery_failed), ambas con `AssignOrderPanel`; "Cancelar" (`canCancel`) con motivo de la lista y nota obligatoria en Otro; "Corregir estado" solo admin, con estado destino y motivo obligatorio; "Crear pedido con lo pendiente" en `partially_delivered`, que llama `createOrder` con las líneas `quantity − delivered_quantity > 0`, mismo cliente, nota "Pendiente del pedido del {fecha}".
- [ ] **Step 3: Prueba de entrega** (`DeliveryProof`): quién recibió, hora, firma, foto, método y monto cobrado; en fallida, motivo y nota; "Entregado sin firma" cuando el evento de corrección lo marca; por línea, entregado vs pedido y motivo.
- [ ] **Step 4: Historial** (`OrderTimeline`): eventos con hora, quién y motivo, en español.
- [ ] **Step 5: Verify** `pnpm tsc --noEmit && pnpm lint && pnpm test`; `/qa` del panel en escritorio y teléfono con un pedido en cada estado.
- [ ] **Step 6: Commit** `feat(orders): order detail with reassign, reprogram, cancel, admin correction, delivery proof and history`

### Task 9: App del chofer (`/deliveries`)

**Files:**
- Create: `app/(app)/deliveries/page.tsx`, `components/deliveries/driver-orders.tsx`, `components/deliveries/delivery-sheet.tsx`, `components/deliveries/signature-pad.tsx`, `components/deliveries/failed-delivery-sheet.tsx`
- Create: `lib/orders/delivery-form.ts` (lógica pura del formulario)
- Modify: `lib/rbac.ts` (`{ prefix: "/deliveries", roles: ["driver"] }`), `app/(app)/page.tsx` (chofer → `redirect("/deliveries")`), navegación del shell (entrada "Entregas" para chofer)
- Test: `tests/delivery-form.test.ts`, `tests/rbac.test.ts`

**Interfaces:**
- Consumes: `listDriverOrders`, `respondToAssignment`, `pickUpOrders`, `recordDelivery`, `uploadDeliveryProof`, constantes de Task 6; `subscribeToOrders` (existente) para recargar.
- Produces (`lib/orders/delivery-form.ts`): `initialLines(items): DeliveryLine[]` (todo entregado), `deliveryOutcome(lines): "delivered" | "partially_delivered" | "invalid"` (todo en cero = invalid), `validateDelivery(form, settings): string[]` (mensajes en español: falta firma, falta nombre, falta foto, falta motivo de una línea, monto sin método).

- [ ] **Step 1: Write the failing tests**: `tests/delivery-form.test.ts` para las tres funciones; en `tests/rbac.test.ts`, `/deliveries` permitido solo a driver y `/orders` sigue denegado a driver.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `lib/orders/delivery-form.ts` y la regla de rbac → PASS.
- [ ] **Step 4: Lista "Mis pedidos"** agrupada: Por aceptar (Aceptar / Rechazar), Por recoger (botón por pedido + "Recoger todos"), En camino (Entregar / No se pudo entregar), Cerrados (últimos 7 días, solo lectura). Cada pedido muestra cliente, dirección, teléfono como enlace `tel:`, fecha y ventana, productos con cantidad y unidad, total a cobrar. Recarga con `subscribeToOrders`, al volver a la pestaña y al reconectar (ADR-010).
- [ ] **Step 5: Entregar**: líneas con cantidad (por defecto todo) y motivo al bajarla; nombre de quien recibe; `SignaturePad` (canvas con eventos de puntero, exporta PNG con `toBlob`, botón "Borrar"; sin dependencias nuevas); foto con `<input type="file" accept="image/*" capture="environment">`; método y monto. El `deliveryId` se genera con `crypto.randomUUID()` al abrir la hoja y se reusa en reintentos; sube firma/foto y luego llama `recordDelivery`. Sin conexión (`navigator.onLine === false` o error de red): aviso "Sin señal. Intenta de nuevo cuando tengas conexión." y el botón queda disponible para reintentar con el mismo id.
- [ ] **Step 6: No se pudo entregar**: motivo de la lista, nota obligatoria en Otro, foto opcional.
- [ ] **Step 7: Verify** `pnpm tsc --noEmit && pnpm lint && pnpm test`; `/qa` a 375 px con el chofer: aceptar, recoger dos, entregar uno completo con firma, uno parcial, una entrega fallida; en otra sesión la oficina ve todo en vivo.
- [ ] **Step 8: Commit** `feat(deliveries): driver app — accept, pick up, deliver with signature, partial and failed deliveries`

### Task 10: Documentación

**Files:**
- Modify: `CLAUDE.md`, `TODOS.md`, `docs/superpowers/specs/2026-11-04-order-fulfillment-e2e-design.md` (estado: fase 1 construida)

- [ ] **Step 1: `CLAUDE.md`**: ADR-012 "Estados por empresa con categorías y steps fijos; transiciones solo por funciones security definer" (decisión, por qué, consecuencias: privilegios por columna en `orders`/`order_items`, toda acción nueva busca su estado por `step`, nunca por clave); tablas nuevas en §4; §8 lo que cubren los tests nuevos; quitar "Entregas (delivery)" de pendientes y dejar inventario y DTE.
- [ ] **Step 2: `TODOS.md`**: "Show who else changed an order" → parcialmente hecho (historial en el detalle; falta en la tarjeta); agregar fase 2 (correos + seguimiento), fase 3 (sin señal), fase 4 (DTE, pregunta 9) y fase 5 (pantalla de configuración) si no están.
- [ ] **Step 3: Commit** `docs: ADR-012 order statuses by category and step; fulfillment phase 1 notes`
