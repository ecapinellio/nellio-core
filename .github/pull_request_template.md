## Qué cambia y por qué

## Tests (ADR-016 — todo cambio entra con tests)

- [ ] Unit (`tests/unit/`) para lógica pura nueva o cambiada
- [ ] Integración (`tests/integration/`) para todo lo que toca Supabase (RPC, RLS, trigger, migración) — con los tres roles y otro tenant
- [ ] E2E (`e2e/`) si cambia un flujo que el usuario recorre
- [ ] Si es un bug: el test lo reproducía y fallaba antes del fix
- [ ] No bajé umbrales de cobertura ni salté tests (`.skip`/`.only`)
