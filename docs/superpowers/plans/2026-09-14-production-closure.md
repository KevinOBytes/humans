# Humans production closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the next code-and-evidence tranche for the Humans MVP without weakening consent, provenance, workspace isolation, audit, or human-review controls.

**Architecture:** Preserve the modular monolith. Add idempotency through the existing principal-bound audit transaction layer, standardize direct-route responses through existing error helpers, and keep hosted smoke credentials operator-supplied and redacted.

**Tech Stack:** Next.js 16, TypeScript, GraphQL Yoga/Pothos generated operations, Drizzle/PostgreSQL, Redis, Vitest, Playwright, Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-09-14-production-closure-design.md`

## Global Constraints

- Keep workspace scoping, authorization, redaction, audit, optimistic versions, and consent mandatory.
- Never store raw idempotency keys or print secrets.
- Do not introduce autonomous adverse decisions, threat scores, or autonomous personal-data collection.
- Use TDD: focused failing test, smallest implementation, focused verification, then broader gates.
- Update `docs/REQUIREMENTS.md` and `TODO.md` only with evidence from tests or runtime checks.
- Use Node.js 24 and pnpm 11.11.0 for local verification.

### Task 1: Durable person-name and event idempotency

**Files:**
- Modify: existing generated GraphQL person-name/event schema and resolvers under `src/modules/people/` and `src/graphql/`
- Test: `tests/integration/graphql-product-acceptance.test.ts` or the focused existing name/event lifecycle suites
- Test: a focused new integration test if no existing lifecycle file owns the replay matrix
- Update: generated GraphQL output only through the repository codegen command

**Interfaces:**
- Consume the existing `derivePrincipalResearchIdempotency` and `runPrincipalIdempotentResearchWrite` helpers.
- Preserve existing unkeyed callers; keyed inputs use `idempotencyKey`, `expectedVersion`, and exact opaque response references.

- [ ] Write failing tests proving concurrent create/update/archive replay for names and events, changed-material conflict, malformed reference rejection before UUID lookup, expiry takeover, workspace/principal fencing, and one redacted audit per committed mutation.
- [ ] Run the focused integration selector and verify the new tests fail for the missing keyed path.
- [ ] Implement the smallest service/GraphQL wiring using the existing transaction and authorization patterns; do not duplicate ledger logic.
- [ ] Run the focused selector, generated-code check, Drizzle drift, typecheck, and lint.
- [ ] Commit with `feat: harden person history idempotency` and record the evidence in the SDD ledger.

### Task 2: Direct-route error and correlation closure

**Files:**
- Modify: direct route handlers under `src/app/api/` that do not yet use the stable error envelope
- Test: `tests/unit/nfr006-security-contract.test.ts` and the relevant route-boundary unit suites
- Test: add focused route contract coverage only where the dynamic inventory currently lacks a concrete assertion

**Interfaces:**
- Use the existing `createGraphQLRequestId`, stable error constructors, and response headers.
- Every failure response must be allowlisted, correlated, `private, no-store`, and free of upstream secrets.

- [ ] Write failing assertions from the route inventory for each remaining route/method boundary, checking status, JSON keys, `x-request-id`, cache policy, and secret-free text.
- [ ] Run the focused route/security tests and capture the failing route list.
- [ ] Implement shared helper use at the route boundary without changing successful response contracts.
- [ ] Run all direct-route unit/security tests plus lint/typecheck.
- [ ] Commit with `fix: close direct route error contracts` and record the evidence.

### Task 3: Credential-safe hosted acceptance harness

**Files:**
- Modify: `scripts/production-readiness-smoke.mjs`
- Test: `tests/unit/production-smoke-contract.test.ts` or the closest existing smoke contract suite
- Update: `docs/operations/production-closeout.md`, `README.md`, `TODO.md`, and `docs/REQUIREMENTS.md`

**Interfaces:**
- Preserve the default public/liveness/readiness smoke behavior.
- Authentication and provider tests remain explicit opt-ins and read values only from the caller's environment/local 0600 file.

- [ ] Write failing contract tests requiring missing-secret errors to name variable names only, redacting values and URLs, and requiring successful authenticated mode to verify sign-in by both configured email and username plus workspace/person readback.
- [ ] Run the focused smoke contract tests and confirm the new assertions fail.
- [ ] Implement redacted env-presence validation, authenticated flow checks, and provider opt-in reporting with stable exit codes.
- [ ] Run the focused smoke contracts and a synthetic local smoke fixture; do not run against production without explicit operator opt-in.
- [ ] Commit with `feat: harden hosted acceptance smoke` and record the evidence.

### Final verification

- [ ] Run formatting, lint, typecheck, all unit tests, generated checks, Drizzle checks, focused integration tests, build, and browser acceptance.
- [ ] Run the required GitHub CI workflow and record the run URL and SHA.
- [ ] Deploy only the verified `main` SHA; inspect the Vercel deployment and aliases without printing secrets.
- [ ] Update the requirement ledger with completed evidence and leave external-provider/hosted-secret gates explicitly incomplete until they are actually exercised.

