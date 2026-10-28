# TODOS

## Order Management

### ~~Mobile app shell (sidebar doesn't collapse on phones)~~ — DONE

**Done 2026-10-25:** below `md` the sidebar is replaced by a ☰ drawer
(`components/mobile-nav.tsx`); no page scrolls sideways at 375px. Page-level
layouts (e.g. the `/orders/historial` table, which now scrolls inside its own
box) are still desktop-first.

**What:** A mobile navigation pattern for the authenticated shell in
`app/(app)/layout.tsx` — today the 208px sidebar is always visible.

**Why:** At 375px the sidebar leaves ~170px for content and every page
scrolls sideways (measured 2026-10-24: `/orders/historial` renders 446px wide
in a 375px viewport). Page-level mobile layouts (e.g. `/admin/users`' stacked
blocks from RBAC Slice 3) can't help while the shell eats half the screen.

**Context:** Found during RBAC Slice 3's browser QA. Deferred because the
pattern (hamburger drawer vs bottom bar vs top row) is an app-wide design
decision — run `/plan-design-review` first. Drivers' delivery view will be
phone-first, so this should land before that.

**Effort:** M
**Priority:** P2
**Depends on:** Nothing. Should precede the driver delivery view and the
mobile kanban TODO below.

### Mobile-friendly kanban board at /orders

**What:** A deliberate mobile layout for the kanban board itself (columns,
drag-and-drop), not just the order detail dialog.

**Why:** Slice 4's order detail dialog got an explicit mobile-first design
pass (user's call, reversing the original "desktop-only for now"
recommendation). The board that opens it is still desktop-oriented —
fixed-width columns (280px floor) with horizontal scroll, not designed
for a phone. If mobile use of the dialog becomes common, the board
underneath it is the natural next piece to need the same treatment.

**Context:** Raised during slice 4's `/plan-design-review` (2026-10-22)
right after the dialog's mobile-first decision — flagged as the logical
follow-up, not built now since it would expand this slice's scope well
beyond "add a detail dialog." Touch drag-and-drop in particular (not just
layout) would need its own design pass — `@dnd-kit`'s `PointerSensor`
doesn't automatically mean good touch ergonomics.

**Effort:** L
**Priority:** P2
**Depends on:** Slice 3 (kanban board) — shipped. Not blocked by slice 4.



### Role-differentiated permissions for order-detail price overrides

**What:** Restrict editing `order_items.price_at_order` (the "edit price" flow
in slice 4's order detail dialog) to `admin` only, instead of both `admin`
and `operator` as today.

**Why:** Today the dialog's price-override edit follows the same RLS model
as the rest of the app (`is_operator_or_admin()`) — admin and operator are
equal. No signal yet that ECTEC needs a finer split, but if a larger client
later wants "only the owner can change a locked-in price," this is the first
place that distinction would need to land (new RLS policy or an in-RPC role
check), and it's worth having the reasoning for *why not now* on record.

**Context:** Raised during slice 4's `/plan-eng-review` (2026-10-18) while
reviewing the new `update_order_detail()` RPC's authorization model. The RPC
explicitly checks `public.is_operator_or_admin()` (see the sibling TODO on
RLS silent-no-op risk resolved in that same review) — adding an admin-only
branch there is a small, contained change if this ever becomes real.

**Effort:** S
**Priority:** P3
**Depends on:** Slice 4 (order detail dialog) — shipped first.

### Full per-product change history (who changed what, every time)

**What:** A history table recording every product change (name, price, unit,
active) with author and time, plus a way to view it.

**Why:** The catalog keeps only the latest `updated_by`/`updated_at`. If a
price ends up wrong there's no way to see how it got there.

**Context:** Deferred in the product catalog eng review (D5, 2026-10-27).
Design it together with "Full price-change history for orders" below — one
history pattern for both.

**Effort:** M
**Priority:** P3
**Depends on:** Product catalog page shipped.

### Full price-change history for orders (not just the most recent)

**What:** A log of every price override an order's line items ever went
through, not just the most recent one.

**Why:** Slice 4 ships `order_items.price_overridden_by`/`price_overridden_at`
— enough to answer "who made the *current* price, and when," but it gets
overwritten on a second edit. If an order's price gets corrected more than
once, the earlier correction(s) and who made them are lost.

**Context:** Raised during slice 4's `/plan-eng-review` (2026-10-18) as a
scope boundary on the audit-trail work — the real use case (a customer
price dispute) normally only needs "who made the current number," not a
full history. Deferred rather than building an `order_item_price_history`
table + trigger up front with no concrete need for it yet.

**Effort:** M
**Priority:** P3
**Depends on:** Slice 4 (order detail dialog, `price_overridden_by/at`) —
shipped first; this extends it.

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

### ~~Admin self-service user creation (RBAC Slice 2)~~ — DONE

**Shipped 2026-10-24** (`6e874ad`) as a Server Action, not the Edge Function
described below — see the admin-user-creation eng review plan.


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

### ~~Admin can deactivate users~~ — DONE

**Shipped 2026-10-24** in RBAC Slice 3 (user list, restore password,
deactivate/reactivate at `/admin/users`).


**What:** UI + action for an admin to deactivate an existing operator/driver
(ban in `auth.users` or a soft-delete flag on `public.users` — not decided
yet) without touching the database directly.

**Why:** CLAUDE.md's "Vistas del frontend por rol" table lists this row as
"Crear/Desactivar usuarios." The admin self-service user creation slice only
builds the "Crear" half — deactivation needs its own view (a list of the
tenant's existing users) and its own design decision (ban vs soft-delete),
which would have doubled that slice's scope.

**Context:** Split out during that slice's `/plan-eng-review` Step 0
(2026-10-24) to keep creation and deactivation as separate, independently
reviewable changes.

**Effort:** M
**Priority:** P3
**Depends on:** Admin self-service user creation — reuses the `/admin/users`
namespace and RBAC rule it introduces.

### ~~Admin can reset a user's password~~ — DONE

**Shipped 2026-10-24** in RBAC Slice 3 (user list, restore password,
deactivate/reactivate at `/admin/users`).


**What:** An admin-only Server Action that generates a new password for an
existing operator/driver in the admin's own tenant (tenant check on the
*target* user, not just the caller) and shows it once, same UX as creation.

**Why:** Creation's "shown once" password has loss paths the leave-guard
can't close: the browser Back button (App Router popstate fires no
`beforeunload`), a dropped response after the user was already created,
or the admin simply closing the tab and confirming. Today the only
recovery is the founder running a script. One reset action covers every
one of those paths instead of hardening each separately.

**Context:** Raised by the `/review` adversarial pass on the admin user
creation slice (2026-10-24). Chosen over intercepting popstate (fragile,
coupled to Next's router internals).

**Effort:** S
**Priority:** P2
**Depends on:** Admin self-service user creation. Pairs naturally with
"Admin can deactivate users" (both need a list of the tenant's users).

### Audit trail for user deactivation (who/when)

**What:** `deactivated_at` / `deactivated_by` on `public.users`, stamped by
the deactivate/reactivate Server Actions and shown in the `/admin/users` list.

**Why:** RBAC Slice 3 deactivates via a Supabase Auth ban only — the list
shows *that* a user is deactivated (`banned_until`) but not who did it or
when. Matters the first time someone asks "who locked me out?".

**Context:** Deferred in RBAC Slice 3's `/plan-eng-review` (2026-10-24, D2-A)
to keep one source of truth for status. If added, the ban stays the
enforcement and these columns are audit-only — same habit as
`price_overridden_by/at`.

**Effort:** S
**Priority:** P3
**Depends on:** RBAC Slice 3 (user list + deactivate/reactivate).

### Force password change on first login for admin-created users

**What:** A `must_change_password` flag on `public.users`, checked at login
and redirecting to a change-password form before the user can reach the app.

**Why:** When an admin creates an operator/driver, the generated password is
shown once in the UI — the admin knows it indefinitely unless the new user
changes it themselves, and nothing today prompts them to.

**Context:** Raised by the outside-voice review during the admin
self-service user creation slice's `/plan-eng-review` (2026-10-24). Judged
acceptable risk for the pilot's 2-3 users (random 24-byte generated
password, communicated out of band) but worth fixing properly later —
doing it right likely also wants an SMTP-backed reset flow, which this
project doesn't have yet.

**Effort:** M
**Priority:** P3
**Depends on:** Admin self-service user creation — this is the feature that
starts handing out admin-known passwords in the first place.

## Product Catalog

### ECTEC's real units (saco, cubeta, tambo, caja…) before loading their catalog

**What:** Extend `products_unit_check` (and `lib/products/units.ts`) with the
units ECTEC actually sells by, once we've seen their real product Excel.

**Why:** Today only `ton, kg, lb, l, gal, each` exist. A chemical distributor
very likely sells by "saco 25 kg", "cubeta", "tambo 55 gal" — if so, the
white-glove catalog load stalls or forces wrong units.

**Context:** Raised by both the eng review and the outside voice of the
product catalog plan (2026-10-27,
`~/.gstack/projects/ecapinellio-nellio-core/emiliocarbonell-main-eng-review-plan-20261026-product-catalog.md`).
Also ask ECTEC: are sizes separate products or presentations of one? Are
prices with or without IVA (13%)?

**Effort:** S
**Priority:** P1 — blocks loading ECTEC's catalog in production.
**Depends on:** ECTEC's product Excel.

### Virtualize the catalog grid for very large catalogs (>1000 products)

**What:** Render only the visible rows of `/products`' grid.

**Why:** Memoized rows (eng review D9) keep typing smooth up to ~1000 rows;
beyond that initial render and paste fill get slow.

**Context:** ECTEC likely has <300 products. Only needed for a much larger tenant.

**Effort:** S
**Priority:** P3
**Depends on:** Product catalog page shipped.

### ~~Dedicated product catalog page (candidate slice 6)~~ — DONE

**Done 2026-10-28:** `/products` — spreadsheet-style grid (paste columns from
Excel, per-cell validation, duplicates, deactivation, concurrent-edit
dialog), phone list with one-at-a-time editing. Plan + reviews:
`~/.gstack/projects/ecapinellio-nellio-core/emiliocarbonell-main-eng-review-plan-20261026-product-catalog.md`.

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
