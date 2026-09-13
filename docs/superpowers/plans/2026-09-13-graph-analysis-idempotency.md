# Graph analysis mutation idempotency

## Context

The graph view mutations already use principal-bound, HMAC-derived idempotency claims and opaque response references. The expensive graph analysis mutation family (`runGraphAnalysis`, `createGraphSnapshot`, `rerunGraphAnalysis`, and `replayGraphSnapshot`) is still non-idempotent at the GraphQL boundary. Retries from browsers, API clients, and job runners can therefore create duplicate analysis runs or snapshots and duplicate audit events. This plan closes that bounded NFR008 gap without changing graph visibility, authorization, or analysis semantics.

## Global constraints

- Preserve workspace and principal tenant isolation and existing graph authorization checks.
- Idempotency keys and raw request material must never be persisted; use the existing HMAC-derived principal-bound transaction helper.
- Replays must be deterministic, validate the stored response reference against current authorized rows, and fail closed on version/state drift.
- Keep backward compatibility for clients that omit an idempotency key only where the current API allows omission.
- Add focused live-PostgreSQL acceptance coverage and regenerate GraphQL artifacts. Do not claim the broader provider/browser/hosted requirements complete from this bounded work.
- Update `docs/REQUIREMENTS.md` and `TODO.md` only with evidence-backed, bounded status.

## Task 1 — graph analysis mutation idempotency

Implement principal-bound idempotency for the expensive graph analysis mutation family. Add optional `idempotencyKey` to the relevant GraphQL inputs (required for operations that create a durable run/snapshot when supplied by the client), derive canonical request material in the service, claim and finalize through `runPrincipalIdempotentResearchWrite`, and replay through authorization-aware loaders. Ensure response references are opaque and bounded: analysis result references identify the run and the request's output contract; snapshot references identify the snapshot; replay references identify the validated snapshot result. Preserve existing lifecycle/version fencing. Add tests proving same-key replay returns the same durable resource, changed material conflicts, cross-principal/workspace attempts fail closed, and audit/domain rows are not duplicated. Regenerate persisted documents and update the requirements ledger.

## Review

A fresh reviewer must inspect the isolated task branch, run the focused live PostgreSQL tests, codegen drift, typecheck, lint, and diff checks, and reject any unverified requirements claim.
