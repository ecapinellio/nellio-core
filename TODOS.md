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
