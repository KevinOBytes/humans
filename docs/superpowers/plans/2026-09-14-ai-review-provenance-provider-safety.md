# Humans AI review, relationship provenance, and provider-safety tranches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Continue the Humans production objective with three bounded integrity fixes discovered after the high-risk governance tranche: durable principal-bound retries for human AI-review decisions, evidence-gated documented relationship claims, and fail-closed isolation for destructive external object-storage contract tests.

**Architecture:** Preserve the modular monolith and generated GraphQL boundary. Domain services own authorization, workspace scope, transaction, provenance, audit, and idempotency. Browser code uses generated operations only. External contract tests must validate target isolation before any network client or child process is created.

**Tech Stack:** Next.js App Router, TypeScript, GraphQL Yoga/Pothos, Drizzle/PostgreSQL, Redis, S3/R2/MinIO adapters, Vitest, Playwright, pnpm 11.11.0, Node.js 24.

**Spec:** `docs/REQUIREMENTS.md` and `docs/ARCHITECTURE.md`, especially HUM-FR-023, HUM-FR-029, HUM-NFR-002, HUM-NFR-008, and HUM-NFR-012.

## Global constraints

- Preserve workspace isolation, consent/purpose, independent human review, redaction, audit immutability, optimistic versions, and stable errors.
- Keyed paths must use `derivePrincipalResearchIdempotency`/`runPrincipalIdempotentResearchWrite`; do not create ledgers or nested transactions.
- Never make `documented` relationship claims appear source-backed without an independently reviewed, version-bound supporting assertion. Do not silently rewrite historical data.
- External contract tests are destructive to their test objects: reject unsafe targets before client construction or subprocess spawn, never disclose credentials/endpoints, and retain local MinIO behavior.
- TDD, focused evidence, no secrets/private data/provider calls, and matched `TODO.md`/`docs/REQUIREMENTS.md` updates are mandatory.

---

### Task 1: Durable idempotency for AI review decisions

**Files:** `src/modules/ai/review-graphql.ts`, `src/modules/ai/review-validation.ts`, `src/modules/ai/review-service.ts`, `src/components/ai/ai-review-queue.tsx`, generated GraphQL operations/artifacts, AI review integration/component tests, `TODO.md`, `docs/REQUIREMENTS.md`.

**Invariants:** Add optional single-decision keys and one batch-level key while preserving unkeyed callers. Canonical material binds operation, suggestion ID/version, decision, normalized reason/confirmation; batch binds the ordered complete ID/version set and decision. One outer principal-ledger transaction commits all item mutations/audits/evidence effects. Store strict opaque suggestion/version/status references and reauthorize current workspace, reviewer, purpose, case, provenance, and resource state on replay. Reject malformed/mismatched references before lookup. Stable UI keys survive uncertain transport and change when material changes.

**TDD:**

- [ ] Add failing live cases for same-key accept/reject/defer and whole-batch convergence, changed material, malformed references, expiry takeover, workspace/principal fencing, replay after access/provenance loss, one audit/effect, and all-or-nothing batch rollback.
- [ ] Implement the smallest shared-ledger wrapper without weakening independent-review/user-only guards; regenerate artifacts.
- [ ] Add focused review-queue tests for key retention/replacement and browser retry behavior.
- [ ] Run focused live/unit suites, codegen, format/lint/typecheck, `test:db`, build, and diff checks; update docs with bounded evidence; commit `feat(ai): make review decisions retry-safe`.

**Scope limit:** Does not close all retryable mutations, provider acceptance, or whole-product browser readiness.

---

### Task 2: Evidence-gate documented relationships

**Files:** `src/db/schema/relationships.ts`, new migration if required, `src/modules/relationships/service.ts`, `src/modules/relationships/graphql.ts` only if needed, `src/components/relationships/relationship-form.tsx`, relationship provenance/live and form unit tests, `TODO.md`, `docs/REQUIREMENTS.md`.

**Invariants:** New relationships default to `analyst_hypothesis`; explicit documented creation is rejected because it has no reviewed assertion. Promotion from hypothesis to documented requires the same workspace/case/purpose/resource/version-bound independently reviewed supporting assertion and confirmation, atomically updating epistemic/review state with one redacted audit. Preserve existing inferred→asserted/corroborated gates and never mutate historical rows silently.

**TDD:**

- [ ] Add failing live cases for omitted/default status, documented-create rejection/no row, missing/unreviewed/wrong/contradicting assertion rejection, valid independent promotion, stale/concurrent promotion, and consent/coverage withdrawal.
- [ ] Add form tests for truthful hypothesis default and no unsupported documented option.
- [ ] Implement migration/schema/service guard with generated artifacts only if necessary; run focused live/unit, schema/drift, format/lint/typecheck/build and `test:db`.
- [ ] Record bounded evidence and commit `fix(relationships): require reviewed evidence for documented claims`.

**Scope limit:** No historical remediation or broad relationship UX rewrite.

---

### Task 3: Fail-closed external contract-test bucket isolation

**Files:** `scripts/production-readiness-smoke.mjs`, shared storage-config validator or test helper, `tests/integration/provider-adapter-contract.test.ts`, provider harness/unit tests, `docs/operations/production-operator.op.env.example`, `docs/operations/production-closeout.md`, `.env.example` only for safe placeholders, `TODO.md`, `docs/REQUIREMENTS.md`.

**Invariants:** For external `r2`/`s3` contract runs, require a clearly isolated contract bucket convention, reject private/application bucket names and equality with `STORAGE_BUCKET`, and return stable non-secret errors before child process/client/network activity. Keep local MinIO paths compatible. Operator references must point to a dedicated contract-test bucket and least-privilege credential without exposing secrets.

**TDD:**

- [ ] Add failing planner/helper tests for unsafe/private/equal bucket rejection before executor/client, valid isolated bucket acceptance, and secret/endpoint-free errors.
- [ ] Add direct provider-suite guard and documentation contract coverage.
- [ ] Implement shared validation, update only reference docs, run focused tests, format/lint/typecheck/build and relevant CI contracts.
- [ ] Record that live isolated R2/S3/Upstash execution remains operator work; commit `fix(storage): isolate external contract buckets`.

**Scope limit:** Does not claim external provider acceptance or provision any bucket/credential.

## Final review

- [ ] Each task gets an isolated implementer, scoped review, fix/re-review loop, and ledger entry.
- [ ] Broad review, full local gates, CI, clean worktree/remote parity, and deployment evidence are required before any tranche is considered complete.
- [ ] Overall Humans goal remains active until the full original requirement matrix has implementation and evidence.
