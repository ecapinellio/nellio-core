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
  los pedidos caóticos). **No son usuarios.** Incluye datos fiscales del
  **receptor** del DTE (opcionales).
- `products` — catálogo. Sin stock (inventario se modela post-discovery).
- `orders` — cabecera del pedido. Guarda el mensaje original en `notes`.
- `order_items` — líneas del pedido. Tabla separada => varios productos por pedido.

### Pendiente de modelar (después del discovery con Milo y Alejandra)
- Inventario / stock / movimientos de inventario / bodegas
- Entregas (delivery) y si soportan entregas parciales
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

---

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
- **Creación de usuarios subsecuentes:** el admin del tenant los crea a través
  de un endpoint del backend (no directo desde el frontend, que no tiene
  privilegios de admin). **El `tenant_id` del nuevo usuario se hereda del JWT
  del admin, nunca del input del frontend.**

---

## 7. Reglas al trabajar con Supabase

- `service_role` key: solo en el backend, **nunca** en el navegador. Salta RLS.
- Probar las políticas RLS **desde la app logueado**, no desde el SQL Editor
  (el editor salta el RLS y muestra todas las filas).
- Toda tabla nueva con `tenant_id`: activar RLS y crear la política de aislamiento.
- Indexar siempre `tenant_id`.

---

## 8. Estilo de trabajo preferido

- Respuestas directas, honestas y concisas: "solo lo necesario, corto y preciso".
- Frontend developer: no asumir contexto profundo de backend/infra sin explicarlo.
- Validar decisiones de arquitectura antes de implementar.
- Usar los discovery calls para informar el modelado, no especular de antemano.

---

## 9. gstack

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