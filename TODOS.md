# TODOS

## Order Management

### Reconciliation tooling for quick-added customer/product records

**What:** An admin screen to find and merge near-duplicate customer/product
records that slip past the unaccent+trigram search — genuinely different
spellings, not just accents (e.g. "Ferreteria Progreso" vs "Ferreteria El
Progreso"), created via quick-add under time pressure.

**Why:** The unaccent+trigram fix (locked in during the capture-flow plan
review) handles accent variance, but won't catch every real-world spelling
variant Alejandra might type while transcribing fast. Left unaddressed, this
recreates the same data-fragmentation problem Nellio exists to solve — just
inside Postgres instead of a spreadsheet.

**Context:** Raised by the outside-voice review during `/plan-eng-review` on
2026-07-04. Not needed until the capture flow has been live long enough to
accumulate real usage and show whether spelling-variant duplicates are an
actual recurring problem, versus a rare edge case. Depends on the capture
flow shipping first — there's no real data to reconcile until then.

**Effort:** M
**Priority:** P3
**Depends on:** Capture-flow slice shipping and being in use by Alejandra.

## Roles / RBAC

### Admin self-service user creation (RBAC Slice 2)

**What:** A Supabase Edge Function running with the `service_role` key, plus a
minimal admin UI form, so an admin can create operator/driver users without
touching the database directly. `tenant_id` is read from the calling admin's
JWT `app_metadata` and stamped onto the new user — never accepted from client
input (CLAUDE.md §6).

**Why:** Today the only way to create a user is `scripts/create-first-user.ts`
run by hand with the service_role key — that's the founder's own bootstrap
path, not something Alejandra or Milo can do themselves. This is also the
"Administración (Crear/Desactivar usuarios)" row of CLAUDE.md's "Vistas del
frontend por rol" table, still unbuilt.

**Pros:** closes the last unbuilt view in the roles table; matches the
`/office-hours` design doc's Approach B scope for the roles layer.

**Cons:** new infrastructure (an Edge Function) to write, deploy, and
maintain. Not a security gap while deferred — the bootstrap script already
covers manual user creation — only an operational bottleneck (only the
founder can do it).

**Context:** Split out from RBAC Slice 1 (T8, RLS + frontend role
enforcement, shipped 2026-09-13) during `/plan-eng-review` Step 0, to keep
that plan from mixing a security-policy change with new infrastructure. See
`~/.gstack/projects/ecapinellio-nellio-core/emiliocarbonell-main-eng-review-plan-20260913-rbac.md`
for the full T8 plan and review report.

**Effort:** M
**Priority:** P2
**Depends on:** T8 (RLS role helpers + `role()`/`is_operator_or_admin()`) —
already shipped, so this is unblocked whenever picked up.

## Product Catalog

### Dedicated product catalog page (candidate slice 6)

**What:** An admin/operator screen to bulk-create and edit the full product
catalog (name, price per unit, unit) outside the order-capture flow — the
place to load everything ECTEC sells during onboarding, so operators rarely
need quick-add's price/unit fields mid-capture at all.

**Why:** Raised directly by the user while scoping the product-pricing
block ("en el mejor de los casos el onboarding del cliente se cargan y
crean todos los productos que tienen de una"). Inline quick-add (in the
capture screen) should still exist for the in-the-moment exception — a
customer orders something not yet in the catalog — but bulk/planned
product management belongs on its own page, not bolted onto order capture.

**Context:** Came up during `/plan-eng-review` for Slice 1 (precio+unidad en
productos, 2026-10-17) as a direct question from the user about where
product creation should live. Not one of the 5 originally-scoped slices
(precio+unidad → rediseño de captura → kanban+DnD → dialog de detalle →
dashboard) — new scope, deliberately not built now. See
`~/.gstack/projects/ecapinellio-nellio-core/emiliocarbonell-main-eng-review-plan-20261017-slice1-product-pricing.md`.

**Effort:** M
**Priority:** P3
**Depends on:** Slice 1 (products.price_per_unit/unit) — shipped.

### ~~order_items price + unit snapshotting (slice 3 input — updated from slice 5)~~ — DONE

**Resolved 2026-10-18** (slice 3, S3a): `order_items.price_at_order`/
`unit_at_order` added, populated by `create_order()` at insert time. No
backfill for pre-migration orders — they render "Sin precio" instead, a
graceful null rather than a fabricated historical value (decided during
`/plan-eng-review` for slice 3, not the backfill strategy this note
originally called for — judged not worth the complexity for a pre-launch
pilot with no real historical data yet).

**What:** `order_items` needs to capture the product's price *and* unit at
the moment an order is placed (e.g. `price_at_order`, `unit_at_order`), not
just reference the current values on `products`.

**Why:** If a product's price or unit changes later, every historical order
referencing it silently changes meaning — a price correction retroactively
changes past revenue, and a unit correction (e.g. fixing a data-entry
mistake, ton → kg) retroactively changes what old orders even mean. Both
fields have the identical bug shape; an earlier draft of this note only
caught the price half.

**Urgency correction (from slice 2's review, 2026-10-17):** originally filed
as "slice 5 input" (dashboard). That undersold it — **slice 3's kanban cards
show "precio del pedido"**, which means slice 3, not slice 5, is the first
slice that needs to re-read a historical order's total. Slice 2's own
capture-screen total is fine as-is (computed live during capture, never
re-read afterward — confirmed not a bug), but don't let that ephemeral-total
reasoning get assumed to also cover slice 3's persistent, re-displayed one.

**Risk to flag explicitly for whoever picks this up:** by the time this is
scoped, slice 2 will already have generated real order data with no
snapshot column at all — this isn't a greenfield schema decision anymore by
then, it needs a backfill/migration strategy (what price/unit do pre-slice-3
orders get retroactively assigned?). That strategy isn't scoped anywhere in
the current 5-slice block. Don't let slice 3 discover this cold.

**Context:** Flagged during Step 0 of `/plan-eng-review` for Slice 1
(2026-10-17), expanded by the outside-voice review during that same session
(which caught the unit half and the backfill-timing risk — the first draft
only named price). Urgency corrected during Slice 2's review (same day) —
see Urgency correction above. Deliberately not solved in slice 2: it's an
`order_items`/`orders` schema decision, not a capture-screen one.

**Effort:** M (plus a backfill strategy — see Risk above)
**Priority:** P1 (raised from P2 — blocks slice 3, not just slice 5)
**Depends on:** Slice 1 (products.price_per_unit/unit) — shipped. Blocks
accurate kanban card pricing (slice 3) and the sales dashboard (slice 5).
