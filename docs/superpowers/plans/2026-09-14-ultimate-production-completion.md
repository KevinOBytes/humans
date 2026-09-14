# Humans Ultimate Production Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining implementable Humans requirements while preserving consent, lawful purpose, provenance, tenant isolation, least privilege, human review, and fail-closed privacy behavior.

**Architecture:** Preserve the existing Next.js App Router modular monolith. PostgreSQL remains authoritative; GraphQL Yoga/Pothos and generated operations are the only browser data boundary; Redis and S3-compatible storage remain behind adapters. Privacy actions use one canonical reviewed lifecycle, durable processor state, and immutable redacted accountability records.

**Tech Stack:** Node 24, pnpm 11.11.0, Next.js, TypeScript, GraphQL Yoga/Pothos, Drizzle/PostgreSQL, Redis, MinIO/R2/S3, Vitest, Playwright, Docker Compose, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-14-full-mvp-closeout-design.md` and the numbered matrix in `docs/REQUIREMENTS.md`.

## Global Constraints

- Preserve workspace/case scoping, least privilege, lawful-purpose and consent checks, redaction, immutable audit attribution, optimistic versions, and principal-bound idempotency.
- No autonomous adverse decisions, threat scores, covert collection, biometric matching, or real-person surveillance dataset.
- Unsupported or unsafe irreversible operations must remain durably rejected with a stable redacted reason; never silently downgrade to soft delete.
- Use generated GraphQL operations for browser data access; browser code must not import database repositories.
- Use Node 24 and pnpm 11.11.0; add a focused failing test before behavior changes.
- Never print or commit secrets, populated environment files, uploads, dumps, logs, provider responses, or agent scratch.
- Update `TODO.md` and `docs/REQUIREMENTS.md` only when the corresponding test or runtime evidence exists.

---

### Task 1: Converge all privacy mutations on canonical governance

**Files:**
- Modify: `src/modules/settings/policy-mutations.ts`, `src/modules/settings/graphql.ts`
- Modify: `src/modules/privacy/request-service.ts`, `src/modules/privacy/retention-service.ts`
- Modify: `src/graphql/operations/privacy-settings.graphql` and generated GraphQL artifacts via codegen
- Test: `tests/integration/settings-policy-administration.test.ts`, `tests/integration/privacy-request-lifecycle.test.ts`, `tests/integration/retention-legal-hold.test.ts`

**Interfaces:**
- Legacy settings deletion mutations must delegate to the canonical privacy request service or return a stable deprecation error; they may not insert or transition `deletion_requests` directly.
- Legacy settings legal-hold mutations must delegate to the canonical retention service so resource visibility, purpose, audit, and independent-release rules are identical.

- [ ] **Step 1: Add failing PostgreSQL assertions** proving direct approval/deleting/completed transitions, self-approved deletion, foreign scope, and self-release of a hold fail without creating an ungoverned executable row.
- [ ] **Step 2: Run the focused integration selectors** with `TEST_DATABASE_URL` when available and record the current failure boundary without changing production code.
- [ ] **Step 3: Route settings deletion and hold operations through canonical services** while preserving a safe compatibility error or equivalent generated operation contract for clients that still send the legacy mutation.
- [ ] **Step 4: Add replay, audit, and workspace-fencing assertions** for both GraphQL documents and verify no raw deletion row can execute without a canonical parent and processor rows.
- [ ] **Step 5: Run codegen, focused PostgreSQL tests, lint, typecheck, and commit** with `fix: converge privacy governance mutations`.

### Task 2: Freeze privacy action snapshots and durable execution outcomes

**Files:**
- Modify: `src/db/schema/privacy.ts`, `src/modules/privacy/request-service.ts`, `src/modules/privacy/retention-request-policy.ts`, `src/modules/privacy/deletion-executor.ts`, `src/modules/privacy/graphql.ts`
- Create: one Drizzle migration and generated metadata only if the snapshot/outcome contract requires it
- Create or modify: `src/modules/privacy/execution-manifest.ts`
- Test: `tests/integration/privacy-request-lifecycle.test.ts`, `tests/integration/privacy-request-idempotency.test.ts`, `tests/integration/retention-legal-hold.test.ts`, focused unit tests for manifests and claims

**Interfaces:**
- Approved destructive requests must freeze action, policy identity/version/hash, lawful-purpose/legal-basis digest, processor-capability version, and required processor set before execution.
- A request/workspace-unique execution outcome must retain state, claim generation/expiry, result code, audit reference, and a value-free manifest containing only resource-kind counts and keyed identity hashes.

- [ ] **Step 1: Add failing tests** for snapshot drift, malformed/foreign snapshot, concurrent claim convergence, expired-claim takeover, stale-generation denial, completed/rejected replay, audit rollback, and no raw values in manifests.
- [ ] **Step 2: Implement snapshot persistence and validation** at review/fulfillment boundaries without weakening existing soft-delete authorization or legacy replay compatibility.
- [ ] **Step 3: Implement the durable outcome/claim record** with PostgreSQL time and generation fencing, atomic redacted audit insertion, and deterministic terminal replay.
- [ ] **Step 4: Keep unsupported hard-delete/anonymization fail-closed** until a resource closure has complete processor/dependency coverage; do not mark those requirements complete merely because a record exists.
- [ ] **Step 5: Run focused PostgreSQL/unit suites, migration drift, typecheck, and commit** with `feat: freeze privacy execution contracts`.

### Task 3: Complete the credential-safe hosted acceptance harness

**Files:**
- Modify: `scripts/production-readiness-smoke.mjs`, `README.md`
- Modify: `docs/operations/production-closeout.md`, `TODO.md`, `docs/REQUIREMENTS.md`
- Test: `tests/unit/production-smoke-contract.test.ts` and direct-route/provider contract suites

**Interfaces:**
- Default smoke remains public/liveness/readiness only; authenticated and provider checks require explicit opt-in and read values only from caller-provided environment or an operator-owned mode-0600 file.
- Diagnostics report variable names and stable failure codes only; they must never print credentials, URLs containing credentials, bucket names when sensitive, provider response bodies, or tokens.

- [ ] **Step 1: Add failing smoke-contract tests** requiring email and username login checks, workspace/person readback, explicit provider opt-ins, and secret-free missing-variable diagnostics.
- [ ] **Step 2: Implement the authenticated smoke path** with safe cleanup/idempotency and provider lifecycle reporting for OpenAI/Ollama, Resend, Upstash, and R2/S3.
- [ ] **Step 3: Add an operator runbook** with exact variable names, no secret values, recovery/2FA/backup-code steps, and a clear distinction between local Compose evidence and attended hosted evidence.
- [ ] **Step 4: Run local smoke fixtures and all route/provider contract tests**; do not claim hosted acceptance without an explicit credential-backed run.
- [ ] **Step 5: Commit** with `feat: complete hosted acceptance harness`.

### Task 4: Close remaining rich-profile and whole-product presentation gaps

**Files:**
- Modify only the files identified by the profile audit under `src/db/schema/`, `src/modules/people/`, `src/modules/facts/`, `src/components/people/`, `src/graphql/operations/`, and generated artifacts.
- Test: focused profile/fact/relationship/research/import/export unit tests plus the relevant Playwright journey.

**Interfaces:**
- Preserve the catalog-backed fact model, temporal precision, evidence/citation provenance, sensitivity/redaction, AI pending-review state, and generated GraphQL-only browser access.

- [ ] **Step 1: Reconcile the audit against the rich-profile matrix** and add failing assertions only for fields or workflows actually absent from the current tree.
- [ ] **Step 2: Implement missing default catalog/form fields** with deterministic keys, insert-missing-only backfill, optional omission, and workspace authorization.
- [ ] **Step 3: Add or complete human-review controls** so AI/web suggestions remain unchecked drafts, accepted fields retain run/source provenance, and relationship hypotheses cannot be silently promoted to documented evidence.
- [ ] **Step 4: Run focused unit/browser tests, codegen drift, accessibility checks, and production build; update the requirement ledger only for proven rows.
- [ ] **Step 5: Commit** with a scope-specific feature/fix message.

### Final verification

- [ ] Run formatting, lint, typecheck, unit tests, Drizzle metadata/drift, auth schema checks, GraphQL codegen drift, dependency policy, and production build.
- [ ] Run the real PostgreSQL/Redis/MinIO integration and security suites, browser acceptance, Compose lifecycle, image verification, and secret scanning.
- [ ] Run a credential-safe hosted smoke only when operator credentials are explicitly supplied through the approved path; record redacted evidence and never retrieve secret values.
- [ ] Perform a whole-diff review, resolve all Critical/Important findings through the SDD review loop, merge only reviewed commits to `main`, push, inspect the exact Vercel deployment, and leave all unperformed external-provider/hosted gates explicitly incomplete.
