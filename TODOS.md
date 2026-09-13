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
