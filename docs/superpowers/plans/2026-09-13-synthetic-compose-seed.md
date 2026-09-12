# Synthetic Compose seed verification

## Context

Humans includes a deterministic fictional demo seed and a production-image
Compose profile, but the release backlog still lacks an executable Compose
seed/GraphQL verification path. This task closes that evidence gap without
introducing real-person data or default credentials.

## Constraints

- Use only fictional Northstar Atlas/Sandbox data and disposable services.
- Require the existing explicit seed guard; never enable seeding implicitly in
  production or commit populated environment values.
- Preserve workspace isolation and generated GraphQL authorization boundaries.
- Keep the test deterministic, bounded, and suitable for CI.

## Task

Add a focused Compose or integration lifecycle check that starts the local
PostgreSQL/Redis/MinIO stack, runs the guarded synthetic seed through the
documented runtime path, verifies idempotent repeat behavior and fictional
records through authorized generated GraphQL/database reads, and proves the
seed is rejected when its explicit opt-in guard is absent. Update
`docs/REQUIREMENTS.md` and `TODO.md` with measured evidence while keeping broad
provider and hosted rows open.

## Verification

Run the focused lifecycle test, then formatting, lint, typecheck, Drizzle
checks, relevant integration tests, and production build. Report any Docker or
hosted-provider evidence that remains unavailable.
