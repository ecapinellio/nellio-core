# CLAUDE.md — Nellio Core

> **Para Claude:** Leé este archivo completo antes de empezar cualquier tarea.
> Es la fuente de verdad del proyecto: overview, estructura, y las decisiones
> de arquitectura (ADRs) con su razón de ser. Después de cada sesión,
> actualizá este archivo **solo si tomamos una decisión nueva, cambiamos una
> anterior, o modificamos la estructura**. No lo actualices por cambios triviales.

---

## 1. Overview

**Nellio Core** es un SaaS de gestión de pedidos y operaciones de distribución.

**Problema que resuelve:** los clientes de un distribuidor hacen pedidos
desorganizados y de último minuto (típicamente por WhatsApp), generando caos
operativo. Nellio Core ayuda a la empresa a **absorber y anticipar** ese caos
externo, no a eliminarlo. El problema de cultura del cliente no se arregla con
software; el producto absorbe el desorden en vez de intentar reformar cómo
piden los clientes.

**Primer cliente / piloto:** ECTEC (Ecología Técnica, S.A. de C.V.), distribuidor
químico en El Salvador. Se usa como piloto pagado y caso de estudio.

**Modelo de negocio:** Nellio es un producto independiente (no parte de ECTEC).
ECTEC es el primer tenant.

---

## 2. Convenciones

- **Todo el código y el SQL en inglés.** Comentarios pueden ir en español.
- Nombres de tablas y columnas en inglés, snake_case.

---

## 3. Stack

- **Backend en el futuro:** Node.js + TypeScript + NestJS + Better Auth. Actualmente solo ocupamos Supabse, para el backend y DB.
- **Base de datos:** Supabase (Postgres + RLS)
- **Frontend:** Next.js
- **Auth:** Supabase Auth; `tenant_id` y `role` viajan en el JWT vía `app_metadata`

---

## 4. Arquitectura de datos (multi-tenancy)

### Modelo actual: shared database + `tenant_id` + RLS
Una sola base de datos. Cada tabla de negocio lleva `tenant_id`. El aislamiento
entre empresas lo garantiza Row-Level Security (RLS) de Postgres, no el código
de la app.

### Tablas del núcleo (implementadas)
- `tenants` — empresas que usan Nellio. **Global**, sin `tenant_id`. Incluye
  datos fiscales del **emisor** para el DTE.
- `users` — gente de la empresa que usa el sistema. Ligada a `auth.users`.
  Roles: `admin` | `operator` | `driver`.
- `customers` — empresas externas que le compran a la empresa (las que mandan
  los pedidos caóticos). **No son usuarios.** Nombre único por tenant (cada
  sucursal es su propio cliente); el NIT puede repetirse entre sucursales. Incluye datos fiscales del
  **receptor** del DTE (opcionales).
- `products` — catálogo. Sin stock (inventario se modela post-discovery).
- `orders` — cabecera del pedido. Guarda el mensaje original en `notes`.
- `order_items` — líneas del pedido. Tabla separada => varios productos por pedido.
- `order_statuses` — estados del pedido **por empresa**: `key` y nombre propios,
  mapeados a una `category` y (los que usa el sistema) a un `step` fijos (ADR-012).
- `tenant_order_settings` — interruptores por empresa del proceso de entrega.
- `order_events` — historial de cada pedido (quién, qué, cuándo).
- `order_deliveries` — cada intento de entrega: resultado (entregada / parcial /
  fallida), firma, receptor, foto y cobro.

### Pendiente de modelar (después del discovery con Milo y Alejandra)
- Inventario / stock / movimientos de inventario / bodegas
- Tabla `dte` completa (firma, transmisión, sello de recepción)

---

## 5. ADRs — Decisiones de arquitectura

### ADR-001: Shared DB + RLS en vez de database-per-tenant
**Decisión:** empezar con base de datos compartida, `tenant_id` en cada tabla,
y RLS, en vez de una base de datos por tenant.
**Por qué:** database-per-tenant es más limpio en aislamiento pero exige
aprovisionamiento automatizado, migraciones en N bases y pooling por tenant —
demasiada infra para un solo dev en etapa de validación. Shared + RLS llega al
piloto mucho más rápido y es el modelo nativo de Supabase.
**Camino futuro (híbrido):** como `tenant_id` está en todas las tablas y la
lógica pasa por él, un cliente grande (ej. Morat Bay corporativo) puede
"graduarse" a su propia DB después sin reescribir la lógica de negocio.

### ADR-002: `tenant_id` y `role` en `app_metadata` del JWT
**Decisión:** los claims de seguridad viven en `app_metadata`, no en `user_metadata`.
**Por qué:** `user_metadata` lo puede editar el propio usuario => un usuario
podría cambiar su `tenant_id` y ver datos de otra empresa. `app_metadata` solo
se modifica desde el servidor con `service_role`.

### ADR-003: Función helper `public.tenant_id()`, no `auth.tenant_id()`
**Decisión:** la función que extrae el `tenant_id` del JWT vive en el schema `public`.
**Por qué:** Supabase no permite crear funciones en el schema `auth` (permission
denied). Además centraliza la extracción del claim: si cambia dónde vive, se
arregla en un solo lugar.

### ADR-004: `users` y `customers` son tablas separadas
**Decisión:** separar quién usa el sistema (users) de quién compra (customers).
**Por qué:** los clientes que mandan pedidos por WhatsApp no son usuarios del
software; los operadores capturan pedidos en su nombre. Mezclarlos es un error
de modelado clásico.

### ADR-005: `order_items` como tabla separada desde el día uno
**Decisión:** modelar líneas de pedido en su propia tabla aunque no esté
confirmado que un pedido lleve varios productos.
**Por qué:** si resulta "un producto por pedido", esta estructura igual funciona
(una sola línea). Al revés obligaría a rehacer. Se eligió la opción que no se rompe.

### ADR-006: Roles/permisos son Fase 1, no diferidos
**Decisión:** el control de acceso por rol entra desde el inicio.
**Por qué:** el rol `driver` no debe ver estadísticas de negocio. El acceso es
fundacional, no incremental. Se protege en dos capas: RLS en la DB + verificación
de rol en el backend.

### ADR-007: Datos fiscales del DTE en el modelo desde el inicio
**Decisión:** meter campos fiscales (NIT, NRC, giro, etc.) en `tenants` (emisor)
y `customers` (receptor) desde ya, aunque la integración con Hacienda venga después.
**Por qué:** retrofitear campos fiscales en registros existentes es doloroso.
La fuente de verdad para el formato es el Manual Tecnológico V2.0 de Hacienda
(factura.gob.sv), no blogs.

### ADR-008: Portal de clientes es visión futura, no Fase 1
**Decisión:** en Fase 1 los clientes NO son usuarios del sistema. Los pedidos
los capturan los operadores (flujo actual por WhatsApp). El portal donde el
cliente crea sus propios pedidos y ve tracking es visión futura.
**Por qué:** construir auth de clientes, portal y políticas RLS por
`customer_id` ahora retrasa el piloto sin validar primero el flujo interno.
**Preparación ya sembrada:** `orders.customer_id` permite filtrar por cliente
cuando exista login de clientes; `orders.channel` contempla agregar `portal`
como canal (y medir migración de caos a self-service).
**Paso intermedio planificado:** tracking link público por pedido (token único,
sin login) que el operador comparte por WhatsApp. Valor inmediato sin auth.
**Cuando se implemente el portal:** requerirá rol `customer` (o auth separada),
política RLS que filtre por `customer_id` (la política actual por `tenant_id`
le daría a un cliente acceso a pedidos de otros clientes), y vínculo entre el
login del cliente y su fila en `customers`.

### ADR-009: Revocación de sesión dentro de `public.tenant_id()`
**Decisión:** `tenant_id()` devuelve `NULL` si la sesión del JWT ya no existe
en `auth.sessions` (se borra al cambiar la contraseña) o si el usuario está
baneado (`banned_until > now()`), o si todavía tiene que cambiar una
contraseña generada por el admin (`app_metadata.must_change_password = true`,
leído de `auth.users`, no del JWT; sin esto quien tuviera la contraseña
temporal entraba directo a la API sin pasar por el proxy). Desactivar = ban de Supabase Auth;
reactivar = desbanear + contraseña nueva **en una sola llamada**.
**Por qué:** un access token sigue siendo válido hasta que expira (1h). Sin
esto, un usuario desactivado o con contraseña restablecida podía seguir
leyendo y escribiendo vía la API REST esa hora. Como todas las políticas y
RPCs pasan por `tenant_id()` (ADR-003), el chequeo en un solo lugar las cubre
a todas. Reactivar cambia la contraseña porque un unban solo **revive** los
refresh tokens congelados por el ban (verificado), p. ej. en un celular
perdido.
**Consecuencias:** las políticas usan `(select public.tenant_id())` para
evaluarla una vez por consulta, no por fila. Toda política nueva debe usar la
misma forma. `tenant_id()` es `security definer` (lee `auth.*`).

### ADR-010: `/orders` en vivo con Supabase Realtime como señal, no como datos
**Decisión:** el tablero se suscribe a cambios de `orders` y `order_items` del
tenant (`postgres_changes`) y, ante cualquier evento, **vuelve a pedir la lista**.
El contenido del evento no se usa. También recarga al volver a la pestaña/app y
al reconectar. El arrastre difiere la recarga hasta soltar.
**Por qué:** varios usuarios trabajan el mismo tablero a la vez. Recargar reusa
la misma consulta y RLS; aplicar eventos sueltos duplicaría esa lógica y se
descuadraría con cualquier evento perdido (un corte de red los pierde).
**Consecuencias:** Realtime evalúa el RLS de cada suscriptor, así que el
aislamiento por tenant y la revocación (ADR-009) aplican igual; lo cubre
`tests/orders-realtime.test.ts`. El filtro `tenant_id` del canal solo reduce
trabajo, no es seguridad. **DELETE no pasa por RLS ni por filtros en Realtime**
(llega a todos con el `id`), así que el tablero solo escucha INSERT y UPDATE, y
estas tablas no deben usar `REPLICA IDENTITY FULL`; si algún día se borran
filas desde la app, usar borrado lógico. Toda tabla que deba verse en vivo se
agrega a la publicación `supabase_realtime` por migración. Los movimientos desde una vista
vieja se siguen rechazando (`updateOrderStatus` con estado esperado).

### ADR-011: Bots — fuera de buscadores y BotID en los formularios de login
**Decisión:** la app no se indexa (`app/robots.txt`, `robots` en metadata y
`X-Robots-Tag` en `next.config.ts`). Los formularios que llaman a GoTrue
desde el servidor (`/login` y `/account/password`) pasan por Vercel BotID:
`initBotId` en `instrumentation-client.ts` + `checkBotId()` en
`lib/auth/actions.ts` **antes** de llamar a GoTrue. Encima, reglas del
Firewall de Vercel (Bot Protection, AI Bots, rate limit al POST de
`/login`) configuradas en el dashboard.
**Por qué:** es una app privada, no hay nada que indexar. Y el login corre
en una Server Action, así que GoTrue ve la IP de Vercel: todos los usuarios
comparten un mismo límite de intentos por IP, y un bot que mande logins
falsos podría dejar a todos sin entrar (auditoría run-1). BotID corta al
bot antes de que gaste ese límite.
**Consecuencias:** `proxy.ts` excluye `robots.txt` y las rutas de BotID
(`/149e9513-…/`) del matcher, o se redirigirían a `/login`. Fuera de
producción `checkBotId()` siempre responde "humano" (dev y tests); la
detección real solo se prueba en un deploy de Vercel. Un formulario nuevo
que llame a GoTrue desde el servidor debe agregarse a `protect` y llamar a
`checkBotId()`.

### ADR-012: Estados por empresa con categorías y steps fijos; transiciones solo por funciones security definer
**Decisión:** cada empresa define sus estados (`order_statuses`: clave, nombre,
posición), pero cada uno pertenece a una `category` fija y los que el sistema
necesita llevan un `step` fijo (`created`, `confirmed`, `accepted`, `picked_up`,
`delivery_failed`, …). Los cambios de estado, chofer y entrega solo ocurren en
funciones `security definer` (`assign_order`, `respond_to_assignment`,
`record_delivery`, …).
**Por qué:** ECTEC y la siguiente empresa nombran y ordenan su proceso distinto;
el código no puede depender de claves. Las categorías dan estadísticas y reglas
comparables entre empresas. Las funciones validan la transición y escriben el
historial en la misma transacción; un PATCH directo se las saltaría.
**Consecuencias:** `authenticated` no tiene GRANT de UPDATE/INSERT sobre las
columnas de estado/entrega de `orders` ni sobre `order_items`. Toda acción nueva
busca su estado por `step` (`order_status_for_step()`), nunca por clave ni por
nombre. Las políticas de lectura del chofer filtran por `category`. Pendiente:
pantalla para editar los estados (TODOS, fase 5).

---

## Vistas del frontend por rol (Fase 1)

| Vista                                      | Admin      | Operador   | Driver              |
|--------------------------------------------|------------|------------|---------------------|
| Crear/capturar pedido                      | Si         | Sí         | No                  |
| Tracking (todos los pedidos del tenant)    | Si         | Sí         | No                  |
| Operaciones (kanban, inventario)           | Si         | Sí         | No                  |
| Estadísticas de ventas, ingresos, margenes | Si         | No         | No                  |
| Entregas                                   | Si (todas) | Si (todas) | Si (Solo las de el) |
| Administración (Crear/Desactivar usuarios) | Si         | No         | No                  |

**Regla:** el frontend esconde, el backend prohíbe. Rutas protegidas leyendo
`role` del JWT + navegación condicional son UX; la seguridad real es RLS +
verificación en backend.

---

## 6. Flujos de seguridad (diseñados, pendientes de implementar)

- **Onboarding del primer usuario (super user):** lo crea el dueño de la
  plataforma vía script server-side con `service_role`. Un usuario no puede
  crearse a sí mismo.
- **Recuperar el acceso de alguien** (p. ej. el primer admin de un cliente):
  `pnpm reset:password --email <correo> [--prod]` — contraseña temporal
  nueva, mostrada una vez, con cambio obligatorio al entrar. `--prod` usa
  `.env.production.local` y pide confirmación. Los admins restablecen a su
  propio equipo desde `/admin/users`.
- **Creación de usuarios subsecuentes:** el admin del tenant los crea a través
  de un endpoint del backend (no directo desde el frontend, que no tiene
  privilegios de admin). **El `tenant_id` del nuevo usuario se hereda del JWT
  del admin, nunca del input del frontend.**

---

## 7. Reglas al trabajar con Supabase

- `service_role` key: solo en el backend, **nunca** en el navegador. Salta RLS.
- **La seguridad está en la clave, no en el código.** Los scripts
  (`bootstrap:admin`, `reset:password`) no otorgan nada sin la clave
  `service_role`, y quien la tenga no los necesita (con `curl` puede todo).
  Reglas:
  - La clave de producción vive solo en `.env.production.local` (ignorado
    por git) y en Vercel (marcada *Sensitive*). Nunca en el código, GitHub,
    chats ni WhatsApp.
  - Para desarrollar se usa Supabase local (claves demo), nunca la de
    producción. No compartir `.env.production.local` con colaboradores.
  - 2FA obligatorio en Supabase, Vercel y GitHub (desde ahí se ve la clave).
  - Si hay sospecha de filtración: crear una clave secreta nueva en
    Supabase (API Keys), revocar la vieja y actualizar Vercel +
    `.env.production.local`.
  - Los cambios de usuarios quedan en Supabase → Authentication → Audit Logs.
- Probar las políticas RLS **desde la app logueado**, no desde el SQL Editor
  (el editor salta el RLS y muestra todas las filas).
- Cambios de estado de pedidos solo por funciones security definer
  (`assign_order`, …); columnas de estado/entrega sin GRANT para `authenticated`.
- Toda tabla nueva con `tenant_id`: activar RLS y crear la política de aislamiento.
- Indexar siempre `tenant_id`.
- Columnas de auditoría (quién creó / quién cambió / cuándo:
  `orders.created_by`, `created_at`, `order_items.price_overridden_by/at`,
  `updated_by`) las escribe un trigger, nunca quien llama a la API (un
  operador puede hacer PATCH directo). Una línea cuyo precio/unidad no
  coincide con el catálogo queda marcada como override, venga de donde
  venga. Los triggers no actúan sin `auth.uid()` ni anidados
  (`pg_trigger_depth() > 1`), para no bloquear `on delete set null`; los
  fixtures de test que necesitan fechas pasadas usan `tenant.service`.
- Checks de valores positivos en `numeric`: `x > 0` deja pasar `NaN`
  (Postgres lo ordena arriba de todo). Agregar siempre `and x <> 'NaN'::numeric`.
- Requisitos de contraseña (mín. 10 con mayúscula, minúscula, número y
  símbolo): definidos en `lib/auth/password.ts` y en `supabase/config.toml`
  (local). **`config.toml` no se sube a producción con `db push`**: en el
  proyecto hosted se configuran a mano en el dashboard (Authentication →
  Providers → Email). Si cambian, actualizar los tres lugares.

---

## 8. Testing

**Comando:** `pnpm test` (una corrida) o `pnpm test:watch` (modo watch). Vitest.

**Requiere el stack local de Supabase corriendo** (`supabase start`) — los
tests son de integración contra Postgres real, no mocks. `tests/fixtures.ts`
crea y borra tenants/usuarios reales vía `service_role`; tiene un guard que
aborta si `NEXT_PUBLIC_SUPABASE_URL` no apunta a `127.0.0.1`/`localhost`.

**Patrón:** cada archivo de test crea su propio tenant + usuarios
admin/operator/driver (`setupTenant()` en `tests/fixtures.ts`), inicia sesión
de verdad con cada uno (no se simula el rol por SQL), y limpia todo en
`afterAll`. Como `tenant_id` está en todas las tablas (ADR-001), los archivos
corren en paralelo sin pisarse.

**Qué cubre hoy:** query helpers (`lib/supabase/queries.ts`), `create_order()`
(validación + atomicidad), paginación de `listOrders()`, y la matriz completa
de RLS por tenant+rol (4 tablas × 3 operaciones × 3 roles), las reglas de
ruta de `lib/rbac.ts`, y la creación de usuarios por el admin
(`createUserInTenant()` + Server Action de `/admin/users`, con rollback),
la gestión de usuarios (restablecer/desactivar/reactivar, `list_tenant_users()`),
la revocación de sesión de `tenant_id()` (ADR-009), y el catálogo de productos
(`save_products()`: guardado en lote, conflictos, repetidos, productos
desactivados; y la lógica pura de la tabla en `lib/products/`), los clientes
(`save_customers()`: formatos de NIT/NRC, NIT compartido, solo actualiza los
campos enviados, conflictos; búsqueda por teléfono/NIT; y `lib/customers/`),
la tabla genérica (`lib/grid/core.ts`), y el cambio de contraseña obligatorio
al primer ingreso (`must_change_password`), y `/orders` en vivo (`subscribeToOrders()`:
eventos por tenant, aislamiento, revocación), y el proceso de entrega
(modelo de estados y privilegios por columna, candados, transiciones de oficina,
`list_driver_orders()` / `respond_to_assignment()`, `record_delivery()` con
parciales y fallidas, estadísticas por categoría, y la lógica pura de
`lib/orders/` (fulfillment, delivery-form, driver-orders)).

**CI:** `.github/workflows/test.yml` corre la suite en cada push/PR contra un
stack de Supabase local efímero (sin secrets — son las keys demo locales).

---

## 9. Estilo de trabajo preferido

- Respuestas directas, honestas y concisas: "solo lo necesario, corto y preciso".
- Frontend developer: no asumir contexto profundo de backend/infra sin explicarlo.
- Validar decisiones de arquitectura antes de implementar.
- Usar los discovery calls para informar el modelado, no especular de antemano.

---

## 10. gstack

Para toda navegación web, usar el skill `/browse` de gstack. **Nunca** usar
las herramientas `mcp__claude-in-chrome__*`.

Skills disponibles de gstack: `/office-hours`, `/plan-ceo-review`,
`/plan-eng-review`, `/plan-design-review`, `/design-consultation`,
`/design-shotgun`, `/design-html`, `/review`, `/ship`, `/land-and-deploy`,
`/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`, `/qa-only`,
`/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`,
`/retro`, `/investigate`, `/document-release`, `/document-generate`,
`/codex`, `/cso`, `/autoplan`, `/plan-devex-review`, `/devex-review`,
`/careful`, `/freeze`, `/guard`, `/unfreeze`, `/gstack-upgrade`, `/learn`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.