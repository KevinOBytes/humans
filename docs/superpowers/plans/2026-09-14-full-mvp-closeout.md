# Humans Full MVP Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining implementable production gaps in governed privacy execution, rich profile/catalog completeness, and whole-product acceptance without weakening consent, provenance, tenant isolation, or audit boundaries.

**Architecture:** Keep the existing Next.js/GraphQL Yoga/Pothos/Drizzle modular monolith. PostgreSQL remains authoritative; Redis and S3-compatible storage stay behind their existing contracts. New behavior is implemented in authorized domain services and exposed through generated GraphQL operations, with browser components consuming only those operations.

**Tech Stack:** Node 24, pnpm 11.11.0, Next.js App Router, TypeScript, GraphQL Yoga/Pothos, Drizzle ORM/PostgreSQL, Redis, MinIO/R2/S3, Vitest, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-14-full-mvp-closeout-design.md` and the numbered matrix in `docs/REQUIREMENTS.md`.

## Global Constraints

- Preserve workspace and case scoping, least privilege, lawful-purpose and consent checks, legal holds, redaction, immutable audit attribution, optimistic versions, and idempotency.
- No autonomous adverse decisions, threat scores, covert collection, or real-person surveillance data.
- Use Node 24 and pnpm 11.11.0; use TDD and generated GraphQL operations.
- Never print or commit secrets, populated environment files, uploads, dumps, logs, provider responses, or agent scratch.
- Unsupported or unsafe irreversible actions must fail closed with a durable redacted reason; never silently map them to soft delete.
- Update `TODO.md` and `docs/REQUIREMENTS.md` only with evidence from tests or runtime checks.

---

### Task 1: Governed irreversible privacy executor

**Files:**
- Inspect/modify: `src/modules/privacy/retention-worker.ts`, `src/modules/privacy/retention-service.ts`, `src/modules/privacy/retention-request-policy.ts`, `src/modules/privacy/graphql.ts`, `src/db/schema/privacy.ts`, `src/db/schema/workspaces.ts`, existing deletion/search/storage/AI processor contracts.
- Create or modify migration files under `drizzle/` only if the state/audit/provenance contract requires a schema change.
- Test: `tests/integration/privacy-request-lifecycle.test.ts`, `tests/integration/retention-legal-hold.test.ts`, `tests/integration/privacy-search-propagation.test.ts`, plus focused unit tests for the executor.

**Interfaces:**
- Consumes existing approved privacy requests, retention policy snapshots, legal-hold queries, processor queues, search cleanup, storage cleanup, and redacted audit service.
- Produces one governed executor that accepts a locked request/policy snapshot and returns a durable terminal outcome; it must support only resource kinds with complete processor coverage and return a stable unsupported outcome otherwise.

- [ ] **Step 1: Write failing PostgreSQL tests** for an approved `hard_delete` person request, an approved `anonymize` person request, a file request, legal-hold fencing, stale policy fencing, concurrent replay, processor failure, audit rollback, and cross-workspace denial. Assert that provenance/audit rows needed for accountability remain and that no partial destructive write commits.
- [ ] **Step 2: Run the focused integration files** with `TEST_DATABASE_URL` and confirm the new cases fail for the currently unsupported actions rather than passing accidentally through soft delete.
- [ ] **Step 3: Implement the smallest executor** behind the existing privacy worker. Acquire the workspace advisory lock, re-read the request/policy/holds, validate processor coverage, perform all resource mutations in one transaction, enqueue external cleanup only through durable processor rows, and write one redacted immutable audit event. Preserve tombstones or irreversible-redaction manifests that contain no source values.
- [ ] **Step 4: Add idempotent replay and recovery semantics** so a completed or rejected request returns its stored outcome, an expired claim can be taken over, and processor failures remain retryable without repeating destructive effects.
- [ ] **Step 5: Run focused tests and review SQL/migration behavior**, then commit with `feat: execute governed privacy actions`.

### Task 2: Rich profile catalog and existing-workspace backfill

**Files:**
- Inspect/modify: `src/db/schema/facts.ts`, `src/db/schema/people.ts`, `src/modules/facts/service.ts`, `src/modules/people/service.ts`, profile GraphQL/UI components under `src/app/people/` and `src/modules/people/`, workspace provisioning/backfill services, and generated GraphQL documents.
- Test: `tests/integration/workspace-profile-definitions.test.ts`, `tests/integration/graphql-product-acceptance.test.ts`, `tests/unit/person-research-panel.test.tsx`, `tests/unit/person-profile*.test.tsx`, and a new focused backfill contract test if needed.

**Interfaces:**
- Consumes the catalog-backed fact-definition model and existing workspace provisioning.
- Produces an idempotent `backfillWorkspaceProfileDefinitions(workspaceId)` service that inserts only missing definitions, preserves custom definitions, records version/audit metadata, and is safe to call from provisioning and an attended migration command.

- [ ] **Step 1: Inventory the current default catalog and profile forms** against the rich-profile requirements. Write failing assertions for aliases, pronouns, biography, employment, education, languages, organizations, public contacts, dated addresses, identifiers, notes, custom fields, and person references, including default values and optional-field omission.
- [ ] **Step 2: Implement missing catalog definitions and backfill** using deterministic namespace/key identifiers, workspace locks, conflict-safe inserts, and no overwriting of custom or user-edited definitions.
- [ ] **Step 3: Add or complete generated GraphQL reads/writes** only where the current profile surface lacks an authorized operation. Preserve per-field sensitivity, purpose, consent, provenance, and reviewer controls.
- [ ] **Step 4: Add component/browser coverage** proving AI suggestions remain unchecked drafts, accepted fields retain run/source provenance, and profile edits remain workspace-scoped and keyboard-accessible.
- [ ] **Step 5: Run generated drift, focused tests, and commit with `feat: complete profile catalog backfill`.**

### Task 3: Whole-product acceptance and provider-safe operational contracts

**Files:**
- Inspect/modify direct-route handlers under `src/app/api/`, provider adapters under `src/modules/providers/`, `scripts/production-readiness-smoke.mjs`, Compose/test workflow contracts, and security/error/redaction tests.
- Test: route-boundary, provider-contract, auth-security, browser, Compose, and production-smoke tests; add focused tests only for uncovered concrete contracts.

**Interfaces:**
- Consumes existing stable error, request-correlation, provider-adapter, secret-scan, and production smoke contracts.
- Produces a deterministic acceptance harness that reports missing provider configuration without probing or printing secrets, validates every direct route's error envelope, and provides explicit operator steps for hosted auth/provider checks.

- [ ] **Step 1: Write failing contract tests** for every discovered direct route's unauthorized/malformed/provider-failure response, correlation header, cache policy, and redaction boundary; include provider configuration diagnostics that never return endpoint, bucket, token, or response content.
- [ ] **Step 2: Implement only the missing route/provider boundaries** using the existing error factory and adapter contracts; do not add network probes or production-secret fallbacks.
- [ ] **Step 3: Extend the smoke/Compose harness** to distinguish local MinIO/Redis/PostgreSQL/Ollama checks from opt-in external R2/S3/Upstash/OpenAI/Resend checks and to emit actionable missing-configuration codes.
- [ ] **Step 4: Add a hosted operator runbook** to `docs/REQUIREMENTS.md`, `TODO.md`, and `README.md` that identifies the exact attended checks required for admin bootstrap/recovery/2FA and provider acceptance without documenting any secret values.
- [ ] **Step 5: Run the complete local and CI-equivalent matrix, then commit with `test: close provider and route acceptance gaps`.**

## Final verification

- [ ] Run `corepack pnpm format:check`, `lint`, `typecheck`, `test:unit`, `db:check`, `db:drift:check`, `auth:schema:check`, `codegen:check`, dependency license/audit checks, and `build`.
- [ ] Run real PostgreSQL/Redis/MinIO integration and security suites, browser acceptance, Compose configuration/lifecycle, image verification, and secret scanning.
- [ ] Review every task report and review package, merge only reviewed commits to `main`, push, and record exact CI/deployment evidence.
- [ ] Keep hosted credentials, live provider calls, and any unsupported irreversible operation explicitly incomplete until attended evidence exists.
