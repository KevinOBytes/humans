# Humans high-risk governance and retry tranches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close three concrete, locally reproducible production-safety gaps discovered during the Humans acceptance audit: stale person authorization before an AI-provider disclosure, transitive legal-hold fencing for person-scoped AI retention, and durable principal-bound replay for privacy-request state transitions. This plan advances the broad product requirements without claiming that hosted credentials, external providers, or every remaining requirement are complete.

**Architecture:** Preserve the modular monolith. Domain services remain the authorization and transaction boundary; GraphQL remains the typed API boundary; repositories remain server-only; generated operations are regenerated after schema changes. External AI calls are treated as disclosure points and must use the most recent authorized snapshot immediately before the call. Retention decisions must serialize with legal-hold mutation. Retryable destructive transitions use the existing principal idempotency ledger and opaque response references.

**Tech Stack:** Next.js App Router, TypeScript, GraphQL Yoga/Pothos, Drizzle/PostgreSQL, Redis, Vitest, pnpm 11.11.0, Node.js 24.

**Spec:** `docs/REQUIREMENTS.md` (especially HUM-FR-005, HUM-FR-023, HUM-NFR-004, HUM-NFR-006, HUM-NFR-008, HUM-NFR-012) and `docs/ARCHITECTURE.md`.

## Global constraints

- Preserve workspace isolation, consent and governed-purpose checks, least privilege, redaction, audit events, optimistic concurrency, and stable closed error envelopes.
- Never send stale, restricted, deleted, foreign-workspace, or consent-withdrawn person data to an AI provider. A final write recheck remains mandatory; it does not replace the pre-disclosure check.
- Legal holds always take precedence over retention deletion, including holds on a person that is explicitly referenced by a person-scoped AI run. Keep direct artifact-hold behavior intact.
- Use the existing `derivePrincipalResearchIdempotency` and `runPrincipalIdempotentResearchWrite` protocol for keyed privacy transitions; do not invent a second replay ledger or nest transactions.
- Use TDD: add a focused failing test, implement the smallest server-side change, then run focused tests and required quality gates.
- Update `docs/REQUIREMENTS.md` and `TODO.md` together with only bounded evidence. Do not mark a broad requirement complete from these tranches.
- Do not add threat scores, autonomous adverse decisions, surveillance-only behavior, or provider calls. Do not read, print, commit, or fabricate credentials.
- Do not commit populated `.env` files, private data, uploads, dumps, logs, generated local state, or `.superpowers` artifacts (the ledger remains git-ignored).
- Each task gets a fresh implementer in an isolated worktree, a scoped independent review, one fix/re-review loop when needed, and a ledger entry. Implementers must not spawn subagents.

---

### Task 1: Re-authorize person web research immediately before AI disclosure

**Purpose:** Eliminate the stale-snapshot disclosure window between the external search and the provider call while preserving the existing human-review and persistence rechecks.

**Files:**

- Modify: `src/modules/people/research.ts`
- Modify: `tests/unit/person-research.test.ts`
- Modify: `tests/integration/graphql-product-acceptance.test.ts` (or the nearest existing person-research acceptance seam)
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces and invariants:**

- Consume the existing `authorizeResearch`, `personResearchRuntime`, `ResearchFixture`, sensitivity/redaction policy, and provider `generate` contract.
- After search/catalog work and before `provider.generate`, reload the person in the active workspace and rerun authorization/purpose checks.
- Build the provider profile from the refreshed row. If the row is missing, foreign, deleted, restricted, or no longer authorized, return the existing closed denial and invoke neither provider nor persistence.
- If a public person becomes internal, the provider input must not contain the stale biography, preferred name, or sort name; conservative denial is acceptable and must be tested.
- Keep the persistence-time authorization and reviewer controls. Do not claim an atomic transaction across the network call.

**TDD steps:**

- [ ] Add deterministic failing unit cases for withdrawn `ai_operation` authority, deleted/foreign/restricted current row, public-to-internal sensitivity change, and unchanged authorized state with source-backed pending proposals.
- [ ] Run the focused unit suite and capture the failure before implementation.
- [ ] Implement the smallest re-read/re-authorize boundary and refreshed outbound projection; preserve stable errors and existing audit semantics.
- [ ] Add a live GraphQL acceptance case that revokes consent or changes sensitivity inside the injected synthetic search callback, spies on `generate`, and asserts no provider/persistence/provenance rows are created on denial.
- [ ] Run focused unit/integration tests, formatting, lint, typecheck, codegen/checks as applicable, and `git diff --check`.
- [ ] Record exact test commands/results in the report and bounded requirement/TODO evidence; commit as `fix(research): reauthorize before provider disclosure`.

**Scope limit:** This does not prove hosted OpenAI/Ollama credentials, remote search-provider behavior, or atomicity against a revocation that races between the final read and network send.

---

### Task 2: Fence AI retention with transitive person legal holds

**Purpose:** Ensure an active legal hold on any person explicitly scoped by an expired AI run preserves that run/thread and prevents a purge audit until the person hold is independently released.

**Files:**

- Modify: `src/modules/ai/retention.ts`
- Modify: `tests/integration/ai-analysis.test.ts`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces and invariants:**

- Consume `aiRuns.reviewPersonIds`, `legal_holds`, the existing workspace advisory/privacy-policy lock, direct thread/child-artifact hold predicates, and redacted retention audit helpers.
- Candidate selection may exclude held person-scoped runs, but the authoritative check must occur inside the lock-protected transaction immediately before deletion.
- Treat active `resourceKind='person'` holds for any scoped ID as a preservation blocker. Retain all existing direct `ai_thread`, `ai_run`, suggestion, citation, and ephemeral-input hold behavior.
- A released person hold permits a later purge exactly once with the existing redacted audit shape.

**TDD steps:**

- [ ] Add failing live PostgreSQL cases for expired completed private thread scoped to a held person, release then purge, direct artifact-hold regression, and a hold-vs-purge race.
- [ ] Run the focused AI integration tests and capture the pre-fix failure.
- [ ] Implement candidate and lock-protected final person-hold checks using the existing lock; avoid unbounded scans and keep batch semantics.
- [ ] Assert held work remains, returns zero purges, writes no purge audit, and released work purges with one redacted audit.
- [ ] Run the focused database suite, formatting, lint, typecheck, and `git diff --check`.
- [ ] Record bounded requirement/TODO evidence and commit as `fix(ai): preserve person-held analysis threads`.

**Scope limit:** This closes the identified person-to-AI retention relation only; it does not redesign legal-hold discovery, export controls, hosted storage, or all retention families.

---

### Task 3: Principal-bound idempotency for privacy-request transitions

**Purpose:** Make review, fulfillment, and cancellation safe to retry after an uncertain response without weakening versioning, independent-review, legal-hold, or deletion safeguards.

**Files:**

- Modify: `src/modules/privacy/graphql.ts`
- Modify: `src/modules/privacy/request-service.ts`
- Modify: `src/graphql/operations/privacy-governance.graphql`
- Regenerate: `src/graphql/generated/`
- Create or modify: `tests/integration/privacy-request-idempotency.test.ts` (or the existing lifecycle suite)
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces and invariants:**

- Add optional `idempotencyKey` to `reviewPrivacyRequest`, `fulfillPrivacyRequest`, and `cancelPrivacyRequest`; preserve unkeyed callers and current `expectedVersion` behavior.
- Keyed paths must call `derivePrincipalResearchIdempotency` and `runPrincipalIdempotentResearchWrite` once at the outer transaction boundary, not nest the existing mutation transaction.
- Canonical request material includes operation, request ID, expected version, normalized target state/evidence IDs, workspace/principal binding, and no secrets.
- Persist and replay only an opaque response reference such as `{ privacyRequestId, version, state }`; on replay re-load the scoped request, re-authorize, validate reference/version/state, and reject malformed or cross-workspace/principal references before lookup.
- Fulfillment must still create at most one propagation/deletion-start effect and one redacted audit. Existing independent-review and legal-hold checks remain authoritative.

**TDD steps:**

- [ ] Add failing live PostgreSQL cases for overlapping same-key review/fulfill/cancel convergence; exactly one state transition/audit/propagation effect; changed canonical material rejection; malformed reference rejection; expired-claim takeover; workspace/principal fencing; stale-version/current-primary replay fencing; and preservation of independent-review/legal-hold preconditions.
- [ ] Run the focused lifecycle/idempotency suite and capture the pre-fix failures.
- [ ] Implement the keyed outer transaction and opaque replay reference with the smallest refactor; regenerate GraphQL artifacts.
- [ ] Preserve unkeyed behavior and stable GraphQL errors; ensure retries never return an old state after a later legitimate transition.
- [ ] Run focused integration tests, codegen check, formatting, lint, typecheck, relevant database tests, and `git diff --check`.
- [ ] Record bounded requirement/TODO evidence and commit as `feat(privacy): make request transitions retry-safe`.

**Scope limit:** This is one high-impact mutation family. AI review decisions, other non-keyed mutations, provider retries, and broad NFR-008 closure remain separate work.

---

## Final review and verification

- [ ] Run a broad independent review against this plan and `docs/REQUIREMENTS.md`; resolve every load-bearing finding with at most one fix/re-review loop.
- [ ] Run the repository's applicable format, lint, typecheck, unit, focused database, schema/drift, auth-schema, codegen, dependency, and production build gates. Report known aggregate fixture limitations separately; never convert them into a false pass.
- [ ] Review `git diff`, `git status`, worktrees, and branch ancestry; commit only reviewed changes, push `main`, and record CI/deployment evidence if it exists.
- [ ] Update `TODO.md`, `docs/REQUIREMENTS.md`, and the production-closeout evidence with exact commands and unresolved external/provider/hosted gaps.
- [ ] Keep the overall Humans goal active until every original requirement and this explicit scope has actual implementation plus evidence; these three tranches alone do not complete it.
