# Humans MVP Acceptance Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the highest-value locally reproducible acceptance gaps without overstating hosted credentials, external-provider, or whole-product evidence.

**Architecture:** Extend the existing modular-monolith domain services and generated GraphQL/browser test boundaries. Each tranche adds a narrow, server-enforced invariant with evidence in the matching integration or browser suite; no browser code may access repositories directly.

**Tech Stack:** Next.js App Router, TypeScript, GraphQL Yoga/Pothos, Drizzle/PostgreSQL, Redis, MinIO/S3 adapters, Vitest, Playwright, pnpm 11.11.0, Node.js 24.

**Spec:** `docs/REQUIREMENTS.md` and `docs/ARCHITECTURE.md`.

## Global Constraints

- Preserve workspace authorization, consent/purpose checks, redaction, audit logging, idempotency, and stable error envelopes.
- Keep protected identifiers fail-closed because assertion quote and locator fields are plaintext.
- Do not add autonomous adverse decisions, threat scores, or surveillance-only behavior.
- Use TDD; run focused tests and the full local quality/build gates before committing.
- Update `docs/REQUIREMENTS.md` and `TODO.md` together with bounded evidence; never mark a whole-product requirement complete from a narrow test.
- Never commit secrets, populated environment files, private data, uploads, dumps, logs, or agent state.

---

### Task 1: Investigation sharing authorization evidence

**Files:**
- Modify: `tests/integration/research-assignment-lifecycle.test.ts` (the existing investigation/case/team PostgreSQL authorization seam).
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: `createInvestigationsService(context).get` and `.list`, the `investigationCaseLinks`, `caseMembers`, `caseTeamLinks`, `teamMembers`, and `teams` schema, and the visibility predicate in `src/modules/investigations/service.ts`.
- Produces: disposable-PostgreSQL evidence proving manager, lead, linked-case-member, linked-team-member, API-key, foreign-workspace, archived-team, and unrelated-reader behavior for both point reads and paginated lists.

- [ ] **Step 1: Add failing live tests** that seed two workspaces, one investigation, linked cases, active/inactive team shares, and principals for each actor class. Assert unrelated and foreign readers receive neutral `NOT_FOUND`/empty-list results, while each explicitly shared principal sees only the in-scope investigation.
- [ ] **Step 2: Run the focused integration suite** with `TEST_DATABASE_URL` and confirm the new assertions fail before the service boundary is corrected.
- [ ] **Step 3: Keep the existing server-side predicate** and adjust only test fixtures or the smallest defect revealed by the failing tests; never authorize through UI state.
- [ ] **Step 4: Run the focused integration suite, format, lint, typecheck, and `git diff --check`.
- [ ] **Step 5: Record bounded evidence in both docs and commit with `test(investigations): prove shared-read authorization matrix`.

### Task 2: Public identifier citation readback

**Files:**
- Create or modify: `src/modules/evidence/assertions.ts` for the authorized list service.
- Modify: `src/modules/evidence/repository.ts`, `src/modules/cases/graphql.ts`, and `src/graphql/operations/cases.graphql`.
- Modify: `src/components/people/person-record-page.tsx` for the profile sources/citations panel.
- Create or modify: `tests/unit/identifier-citation-path.test.ts` and `tests/integration/person-identifier-provenance.test.ts`.
- Modify: generated GraphQL artifacts under `src/graphql/generated/`.
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: `requireIdentifierCitation`, `evidence_assertions`, source/evidence visibility policies, and canonical paths `identifiers.<uuid>.v<version>.<field>`.
- Produces: a paginated `personIdentifierCitations(personId, first, after)` operation and a profile panel exposing only authorized public citation metadata, never protected identifier values.

- [ ] **Step 1: Add failing tests** for public citation readback, workspace isolation, hidden source/evidence omission, malformed cursor rejection, stale version binding, and protected citation fail-closed behavior.
- [ ] **Step 2: Run the focused tests and confirm the operation/panel is absent or fails.
- [ ] **Step 3: Implement the domain list method with workspace/person/resource/source visibility checks, cursor bounds, canonical path validation, and no protected plaintext projection. Wire it through generated GraphQL and the existing profile data flow.
- [ ] **Step 4: Add the profile “Identifier citations” panel with source title/URL, field/version binding, locator, bounded quote, confidence, reliability, and review state. Keep loading/error/empty states accessible and workspace-scoped.
- [ ] **Step 5: Regenerate artifacts, run focused tests, full unit tests, format, lint, typecheck, schema/drift checks, build, and diff check.
- [ ] **Step 6: Record bounded evidence in both docs and commit with `feat(evidence): expose governed identifier citation readback`.

### Task 3: Whole-product direct-route security acceptance

**Files:**
- Modify: `tests/unit/nfr006-security-contract.test.ts`, `tests/unit/direct-route-method-contract.test.ts`, `tests/unit/direct-route-input-contract.test.ts`, and `tests/unit/graphql-error-contract.test.ts`.
- Modify: `tests/integration/graphql-security-boundaries.test.ts`.
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: direct route handlers under `src/app/api/`, the centralized stable error/correlation helpers, API-key scope enforcement, and `resourceVisibilitySql`.
- Produces: deterministic evidence for every concrete direct route covering method boundaries, correlation IDs, private cache policy, malformed JSON, unauthenticated/API-key denial, and workspace non-disclosure.

- [ ] **Step 1: Enumerate concrete direct routes from the source tree and add failing contract assertions for any route missing method, correlation, cache, or closed-error coverage.
- [ ] **Step 2: Run the contract suite and capture the exact missing boundary.
- [ ] **Step 3: Add the smallest shared-handler or route-specific correction while preserving successful response shapes and redaction.
- [ ] **Step 4: Run the full security unit suite, representative live GraphQL suite, format, lint, typecheck, and diff check.
- [ ] **Step 5: Update both docs with bounded route evidence and commit with `test(security): cover direct-route acceptance matrix`.

## Review

Each task requires a fresh implementer, a scoped specification/code-quality review, a fix round when findings exist, and a scoped re-review. After all tasks, run a broad whole-branch review and repeat the full CI-equivalent local gates. Hosted administrator sign-in, external Upstash/R2/S3/Resend/AI acceptance, and whole-product performance/accessibility remain open until their required external evidence exists.
