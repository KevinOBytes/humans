# Contact and location durable retry acceptance

## Goal

Close the bounded contact/location evidence gap in HUM-NFR-008 without claiming the full mutation matrix complete.

## Global Constraints

- Preserve current workspace/principal authorization, sensitivity redaction, temporal invariants, consent checks, audit/search effects, and legacy service callers.
- Keep the existing required GraphQL idempotency-key contract; do not introduce an incompatible optional-key rewrite.
- Use generated GraphQL documents, a disposable PostgreSQL database, and real transaction/authorization behavior.
- No production credentials, real person data, or hosted mutations.

## Task 1: Verify and harden contact/location retry boundaries

Inventory contact (including phone aliases), address, and place create/update/archive mutations. Add generated-operation acceptance for concurrent replay convergence, one durable claim/audit per actual mutation, changed-material conflicts, malformed opaque references, expiry takeover, and workspace/principal fencing. Preserve archive outcome semantics and current visibility checks. Add the acceptance suite to the database CI command. Any production fix must first be demonstrated by a focused failing test; if existing behavior already satisfies the contract, retain it and add bounded evidence. Update REQUIREMENTS.md and TODO.md together. Run focused live integration, unit, formatting, lint, typecheck, schema/codegen drift and production build gates, then commit for independent review.
