# Humans Production Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining release gates for the consent-governed Humans platform while preserving workspace isolation, human review, provenance, and auditable operations.

**Architecture:** Extend the existing modular monolith through Drizzle schema migrations, domain services, generated Pothos GraphQL operations, and client panels. Durable actions remain transactionally fenced and provider writes are replay-safe. Production verification is performed by a redacted, environment-injected smoke harness; no secret is written to the repository or printed.

**Tech Stack:** Node.js 24, pnpm 11, Next.js 16, TypeScript, GraphQL Yoga/Pothos, Drizzle/PostgreSQL, Redis/Upstash, S3-compatible storage/MinIO/R2, Vitest, Playwright, Docker Compose, Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-09-11-consent-governed-investigative-research-design.md`, `docs/REQUIREMENTS.md`, and the original consent-governed person/relationship/provenance requirements.

## Global Constraints

- Every domain read and mutation is workspace-scoped and authorization-before-disclosure; foreign resources return neutral denial or empty results.
- A purpose, lawful-basis/consent coverage, sensitivity classification, and required case boundary are checked before restricted reads, writes, AI suggestions, or exports.
- AI may suggest only; accepted facts and relationships require explicit human review and retain run/source provenance. No threat scores or autonomous adverse decisions.
- Retryable mutations use optimistic versions and principal-bound idempotency; replay must not duplicate domain or audit effects.
- Audit metadata is allowlisted and redacted; secrets, private values, prompts, tokens, and raw uploads never enter logs or generated client projections.
- Node.js 24 and pnpm 11.11.0 are required; migrations, generated GraphQL artifacts, format, lint, typecheck, tests, and production build must pass before integration.
- `.env`, credentials, provider responses, private data, uploads, dumps, logs, and agent scratch remain ignored and uncommitted.

### Task 1: Reviewed governed export approvals

**Files:**
- Create: `src/db/schema/export-approvals.ts`
- Create: `src/modules/exports/approval-service.ts`
- Modify: `src/db/schema/index.ts`
- Modify: `src/modules/search/service.ts`
- Modify: `src/modules/search/graphql.ts`
- Modify: `src/graphql/operations/research-analysis.graphql`
- Create: `drizzle/<generated-export-approval-migration>.sql` and snapshot metadata via `pnpm db:generate`
- Test: `tests/unit/export-approval-service.test.ts`, `tests/integration/export-approval-lifecycle.test.ts`
- Modify: `tests/unit/export-redaction-preview.test.ts`
- Modify: `docs/REQUIREMENTS.md`, `TODO.md`

**Interfaces:**
- `createExportApprovalService(context).request(input)` creates a workspace/case/purpose/preview-hash-bound approval request and returns a redacted projection.
- `createExportApprovalService(context).review(input)` requires an independent owner/admin or assigned case reviewer, verifies optimistic version, and records approve/reject plus reason and audit reference.
- `createExportApprovalService(context).requireApproved(input)` accepts the exact workspace, actor, purpose, case, redaction profile, preview hash, and current time and throws a stable `PRECONDITION_FAILED` error unless a non-expired approval exists.
- `commitExport` must call `requireApproved` whenever the preview requires review and must bind the approval hash to the same deterministic export request.

- [ ] **Step 1: Write failing service and GraphQL tests** for request/review authorization, creator self-approval rejection, case reviewer scope, stale versions, purpose/preview mismatch, expiry, and idempotent replay.
- [ ] **Step 2: Run focused tests and confirm the new approval service is absent.**
- [ ] **Step 3: Add the approval table, service, generated GraphQL input/output types, and migration.** Store only purpose, case, preview hash, redaction profile, actor/reviewer IDs, state, reason, expiry, version, and audit references.
- [ ] **Step 4: Wire export preview/commit and settings/evidence UI operations without exposing values.** The commit path must never silently downgrade an approval-required export.
- [ ] **Step 5: Run focused unit/integration tests, `pnpm codegen`, `pnpm db:check`, and `pnpm db:drift:check`.**
- [ ] **Step 6: Commit as `feat: require reviewed approval for governed exports`.**

### Task 2: AI source/evidence linkage and retention enforcement

**Files:**
- Modify: `src/db/schema/person-research.ts`, `src/db/schema/ai.ts`
- Modify: `src/modules/ai/review-service.ts`, `src/modules/ai/research.ts`
- Modify: `src/modules/privacy/retention-service.ts`, `src/worker/handlers/ai-analysis.ts`
- Modify: `src/modules/ai/review-graphql.ts`, `src/graphql/operations/ai-review.graphql`
- Create: migration and snapshot generated from the schema changes
- Test: `tests/unit/ai-source-provenance.test.ts`, `tests/integration/ai-review-retention.test.ts`
- Modify: `tests/unit/person-research.test.ts`, `tests/unit/ai-review-queue.test.tsx`
- Modify: `docs/REQUIREMENTS.md`, `TODO.md`

**Interfaces:**
- A web-research run stores immutable source snapshots with URL, title, publication/collection timestamps, retrieval hash, provider/model, and source reliability metadata.
- Accepted suggestions retain an immutable `acceptedFromRunId`/field-level evidence linkage; the source snapshot cannot be mutated or replaced by a later run.
- `evaluateAiRetention(now)` returns deterministic purge candidates for expired runs, suggestions, citations, and encrypted ephemeral inputs while preserving accepted domain facts and audit records.

- [ ] **Step 1: Add failing tests** for source snapshot hash immutability, accepted suggestion linkage, provider/source disagreement, and retention expiration with legal-hold fencing.
- [ ] **Step 2: Implement immutable source/evidence linkage and retention candidate evaluation.**
- [ ] **Step 3: Wire the bounded worker path and GraphQL projections; preserve human accept/reject controls and provenance in the UI.**
- [ ] **Step 4: Run focused tests plus typecheck/build and commit as `feat: retain immutable ai source provenance`.**

### Task 3: Redacted production/provider release harness

**Files:**
- Create: `scripts/production-readiness-smoke.mjs`
- Create: `tests/unit/production-readiness-contract.test.ts`
- Modify: `package.json`, `.env.example`, `docs/operations/production-closeout.md`, `docs/REQUIREMENTS.md`, `TODO.md`
- Modify: `.github/workflows/ci.yml` only if the contract requires a non-secret CI invocation

**Interfaces:**
- `pnpm production:smoke -- --base-url <url>` checks homepage, liveness, readiness, unauthenticated GraphQL, protected jobs, and (when `PRODUCTION_SMOKE_AUTH=1`) signs in using process-injected `ADMIN_EMAIL`/`ADMIN_PASSWORD`, creates/selects the first workspace, and creates/reads a synthetic person. It prints status codes and correlation IDs only, never response bodies containing secrets.
- `pnpm production:smoke -- --provider-contracts` runs only when explicit `RUN_EXTERNAL_PROVIDER_CONTRACTS=true`; missing credentials result in a clear skipped result, never a production request.

- [ ] **Step 1: Write failing contract tests** for URL validation, redacted output, secret-free errors, auth opt-in, and provider opt-in.
- [ ] **Step 2: Implement the smoke harness using native `fetch`, stable GraphQL operations, and explicit timeouts.**
- [ ] **Step 3: Run the harness against the current local Compose stack, then the exact production deployment after a deliberate production deploy.**
- [ ] **Step 4: Record exact deployment SHA/URL, provider contract outcomes, and remaining gaps in the operations document and requirement matrix.**
- [ ] **Step 5: Commit as `chore: add redacted production readiness smoke`.**

### Task 4: Whole-product verification and release closeout

**Files:**
- Modify: `tests/unit/nfr006-security-contract.test.ts`, `tests/unit/nfr007-redaction-contract.test.ts`, and relevant route tests
- Modify: `tests/e2e/*.spec.ts` only for uncovered original requirements
- Modify: `scripts/compose-lifecycle.mjs`, `scripts/production-readiness-smoke.mjs` only for proven failures
- Modify: `docs/REQUIREMENTS.md`, `TODO.md`, `docs/operations/production-closeout.md`

- [ ] **Step 1: Run the full local matrix under Node 24 with a disposable PostgreSQL/Redis/MinIO Compose environment.**
- [ ] **Step 2: Run the production build and Docker image/security checks.**
- [ ] **Step 3: Deploy the merged main commit to the linked Vercel project only after all local gates pass; verify Ready state, custom hostname, liveness/readiness, authenticated admin bootstrap, synthetic person creation, storage, AI provider fallback, and scheduled jobs.**
- [ ] **Step 4: Run the full browser/accessibility and representative performance matrix; classify any provider-dependent or user-action-dependent evidence separately.**
- [ ] **Step 5: Update requirement rows only where current evidence meets the row’s scope; retain explicit unchecked rows for missing external evidence.**
- [ ] **Step 6: Request a whole-branch code review, resolve findings, squash-merge the release branch, prune stale branches/worktrees, and verify `main` parity.**

