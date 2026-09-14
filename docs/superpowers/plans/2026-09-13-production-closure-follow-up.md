# Production closure follow-up

## Global Constraints

- Preserve workspace authorization, consent, redaction, audit, and idempotency boundaries.
- Do not add autonomous adverse decisions or threat scoring.
- Use TDD and run Node 24/pnpm quality gates before integration.

## Tasks

### Task 1: Identifier provenance linkage

Add a governed, field-level source citation path for person identifiers using the existing evidence assertion/provenance model. It must preserve workspace authorization, sensitivity redaction, immutable source/custody metadata, and GraphQL/API usability. Add focused tests and generated artifacts as needed; do not expose protected identifier values.

### Task 2: Production operator smoke and documentation

Improve the production operator smoke/runbook so an operator can verify hosted administrator sign-in, password rotation, 2FA, and provider readiness without exporting secrets or committing populated env files. Keep the command safe, redacted, and explicit about unavailable provider credentials. Add tests/docs as appropriate.
