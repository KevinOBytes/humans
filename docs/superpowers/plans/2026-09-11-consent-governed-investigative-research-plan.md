# Consent-Governed Investigative Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add enforceable consent, purpose, provenance, case, privacy, retention, approval, and human-reviewed AI capabilities to Humans while preserving workspace isolation and excluding covert or autonomous surveillance behavior.

**Architecture:** Extend the existing modular monolith with additive Drizzle tables, generated GraphQL operations, domain services, and focused UI panels. Authorization checks are composed from actor, workspace/case membership, sensitivity, field policy, consent/purpose coverage, retention/legal hold, and operation approval; browser code continues to consume only generated GraphQL operations.

**Tech Stack:** Next.js, TypeScript, PostgreSQL, Drizzle ORM, Pothos GraphQL, Vitest, Playwright, Tailwind CSS, existing OpenAI-compatible/Ollama adapters, Redis-backed jobs, and S3-compatible storage.

**Spec:** `docs/superpowers/specs/2026-09-11-consent-governed-investigative-research-design.md`

## Global Constraints

- Use Node.js `24.x` and the pnpm version declared in `package.json`.
- Preserve `workspaceId` scoping and route all browser data access through generated GraphQL operations and authorized domain services.
- Every new workspace table has an application-generated UUID, workspace foreign key, version, actor attribution, timestamps, soft-delete fields where the surrounding schema uses them, and workspace-aware foreign keys.
- New sensitive writes and AI acceptance fail closed without active purpose/consent/lawful-basis coverage; legacy records are labeled `legacy_unreviewed` during migration rather than receiving fabricated consent.
- Every restricted read, export, consent change, privacy action, approval, AI retrieval, and accepted suggestion writes a redacted audit event.
- No covert collection, hidden administrator access, biometric identification, watchlists, predictive risk scoring, private-account scraping, or autonomous adverse decision behavior may be implemented.
- All mutations use existing idempotency, optimistic-version, GraphQL error, and audit conventions.
- Run focused TDD tests before implementation, then the relevant integration/browser tests; before integration run formatting, lint, typecheck, unit tests, Drizzle checks, codegen checks, and production build.
- Never commit populated environment files, credentials, private data, uploaded files, database dumps, or local agent state.
- Update `docs/REQUIREMENTS.md` and `TODO.md` together when acceptance status changes; checked requirements require test or runtime evidence.

---

## Scope coverage matrix

| Requested capability | Authoritative implementation and verification |
| --- | --- |
| Rich person profiles | Task 5 profile form, versioned fact definitions, synthetic profile fixtures, component tests, and browser acceptance coverage |
| Temporal relationship graph | Task 2 relationship metadata/evidence assertions and Task 5 graph-state UI/e2e coverage |
| Evidence and provenance | Task 2 source/assertion links, Task 3 AI-run provenance, and provenance integration tests |
| Case/workspace model | Task 2 cases, memberships, assignment queues, sharing boundaries, and authorization tests |
| Privacy and governance | Tasks 1 and 4 consent coverage, field redaction/encryption, retention, legal holds, privacy requests, and export tests |
| Auditability | Tasks 1, 2, 4, and 6 approval records, audit events, bulk alerts, break-glass review, and administrator activity tests |
| AI-assisted research | Task 3 evidence-backed suggestion queue, accept/reject/defer controls, and AI lifecycle tests |
| Search and analysis | Task 6 bounded faceted search, timeline, source comparison, duplicate/contradiction review, and explainable metrics |
| Controlled import/export | Task 6 schema-mapping previews, CSV/JSON/document validation, provenance preservation, redaction preview, and expiring exports |
| Security | Task 6 API-key scope/revocation/rate-limit controls plus existing tenant isolation, encryption, 2FA, backup codes, session, and audit regression tests |
| Synthetic demo data | Task 5 fictional rich profiles and graph fixtures with a no-real-data assertion |

---

### Task 1: Governance, consent coverage, and approvals

**Files:**
- Create: `src/db/schema/governance.ts`
- Modify: `src/db/schema/enums.ts`
- Modify: `src/db/schema/privacy.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0032_governance_consent_scope.sql` and generated metadata snapshots
- Create: `src/modules/governance/types.ts`
- Create: `src/modules/governance/validation.ts`
- Create: `src/modules/governance/coverage.ts`
- Create: `src/modules/governance/service.ts`
- Create: `src/modules/governance/graphql.ts`
- Modify: `src/graphql/schema.ts`
- Create: `src/graphql/operations/governance.graphql`
- Modify: `tests/unit/domain-conventions-contract.test.ts`
- Create: `tests/unit/governance-validation.test.ts`
- Create: `tests/unit/governance-coverage.test.ts`
- Create: `tests/integration/governance-api.test.ts`
- Modify: `tests/integration/full-schema.test.ts`
- Modify: `tests/support/graphql.ts`

**Interfaces:**
- Produces `checkPurposeCoverage(context, input): Promise<{ allowed: boolean; reason: "covered" | "missing_consent" | "expired" | "withdrawn" | "field_not_permitted" | "case_not_permitted" | "legal_hold"; consentRecordId: string | null; policyId: string | null }>`.
- Produces `createGovernanceService(context)` with `createPurposePolicy`, `setFieldPolicy`, `recordConsent`, `withdrawConsent`, `getCoverage`, `requestApproval`, `reviewApproval`, and `listApprovals` methods.
- Produces GraphQL operations `consentCoverage`, `createConsentRecord`, `withdrawConsent`, `accessApprovals`, `requestAccessApproval`, and `reviewAccessApproval` with bounded pagination and generated documents.

- [ ] **Step 1: Write failing validation tests.** Cover normalized purpose/scope values, UTC effective intervals, explicit lawful-basis values, withdrawal effects, field sensitivity ceilings, non-empty approval reasons, and rejection of control characters or unbounded JSON.
- [ ] **Step 2: Run the focused validation tests and verify they fail.**

  Run: `pnpm vitest run tests/unit/governance-validation.test.ts`

  Expected: FAIL because the governance validation module and enums do not yet exist.

- [ ] **Step 3: Add governance enums and Drizzle tables.** Define policy, field-policy, consent-scope, and access-approval records with checks for interval order, scope cardinality, version positivity, and workspace-scoped foreign keys. Extend consent rows with notice version, collection method, lawful-basis metadata, withdrawal effect, and reviewer attribution. Do not make existing legacy rows invalid at migration time.
- [ ] **Step 4: Implement normalization and purpose coverage.** The coverage function must resolve the person, field definition, optional case, and active policy in the same workspace; require a current consent/lawful-basis record for writes, exports, AI operations, and restricted reads; and return a reason code without leaking protected values.
- [ ] **Step 5: Implement the service and GraphQL layer.** Reuse `ResearchServiceContext`, `resourceVisibilitySql`, audit transactions, idempotency, and generated Pothos conventions. A withdrawal mutation must write an audit event and invalidate new coverage without deleting data itself.
- [ ] **Step 6: Regenerate migrations and GraphQL artifacts.** Run `pnpm db:generate`, `pnpm db:check`, `pnpm db:drift:check`, `pnpm codegen`, and `pnpm codegen:check`; inspect the generated diff and keep the migration count assertion synchronized.
- [ ] **Step 7: Add integration coverage.** Prove a consent-required write is rejected without coverage, accepted with active coverage, rejected after expiry/withdrawal, and cannot cross workspaces. Prove an API key with no approval cannot read restricted fields.
- [ ] **Step 8: Run focused gates and commit.**

  Run: `pnpm vitest run tests/unit/governance-validation.test.ts tests/unit/governance-coverage.test.ts tests/integration/governance-api.test.ts tests/integration/full-schema.test.ts && git diff --check`

  Commit: `feat(governance): enforce consent and purpose coverage`

---

### Task 2: Cases, temporal graph semantics, and evidence assertions

**Files:**
- Create: `src/db/schema/cases.ts`
- Modify: `src/db/schema/relationships.ts`
- Modify: `src/db/schema/evidence.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0033_cases_and_evidence_assertions.sql` and generated metadata snapshots
- Create: `src/modules/cases/types.ts`
- Create: `src/modules/cases/validation.ts`
- Create: `src/modules/cases/service.ts`
- Create: `src/modules/cases/repository.ts`
- Create: `src/modules/cases/graphql.ts`
- Create: `src/modules/evidence/assertions.ts`
- Modify: `src/modules/relationships/service.ts`
- Modify: `src/modules/relationships/repository.ts`
- Modify: `src/modules/relationships/graphql.ts`
- Modify: `src/graphql/schema.ts`
- Create: `src/graphql/operations/cases.graphql`
- Create: `tests/unit/cases-validation.test.ts`
- Create: `tests/unit/evidence-assertions.test.ts`
- Create: `tests/integration/cases-api.test.ts`
- Create: `tests/integration/relationship-provenance.test.ts`
- Modify: `tests/integration/graphql-product-acceptance.test.ts`

**Interfaces:**
- Produces `createCasesService(context)` with `createCase`, `addMember`, `linkResource`, `getCase`, `listCases`, and `timeline` methods.
- Produces `linkEvidenceAssertion(context, input)` where `input` includes `evidenceId`, `resourceKind`, `resourceId`, `locator`, `quote`, `role`, and `confidence`; the operation returns a versioned assertion row and audit reference.
- Extends relationship create/revise inputs with `caseId`, `validFrom`, `validUntil`, `observedAt`, `creationMethod`, `reviewState`, and evidence references while preserving explicit confirmation for relationship creation.

- [ ] **Step 1: Write failing tests for case boundaries and evidence assertions.** Cover case membership narrowing visibility, resource links limited to the same workspace, required purpose coverage, valid temporal intervals, bounded quote/locator sizes, and prohibited inferred-to-asserted promotion without review.
- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run: `pnpm vitest run tests/unit/cases-validation.test.ts tests/unit/evidence-assertions.test.ts`

  Expected: FAIL because case and assertion services do not yet exist.

- [ ] **Step 3: Add case and assertion tables.** Define cases, case members, case resource links, and generic evidence assertions with unique workspace keys, resource-kind checks, temporal checks, soft deletion, and audit attribution. Add relationship metadata columns and indexes without weakening existing uniqueness or visibility constraints.
- [ ] **Step 4: Implement case authorization.** Case visibility must intersect existing resource visibility. A case link can narrow access but never grant access that the actor lacks on the linked resource.
- [ ] **Step 5: Implement evidence assertion service.** Resolve source/evidence/resource in one workspace, call governance coverage for the action, normalize locators and quotes, and write a redacted audit event. Expose source reliability, information credibility, and reviewer state without exposing encrypted payloads.
- [ ] **Step 6: Extend relationship service and GraphQL.** Preserve state-transition rules and explicit confirmation. A promotion from `inferred` to `asserted` or `corroborated` must require a reviewer permission, evidence assertion, and approval record.
- [ ] **Step 7: Regenerate migration and GraphQL artifacts and run integration tests.**

  Run: `pnpm db:generate && pnpm db:check && pnpm db:drift:check && pnpm codegen:check && pnpm vitest run tests/integration/cases-api.test.ts tests/integration/relationship-provenance.test.ts tests/integration/graphql-product-acceptance.test.ts`

- [ ] **Step 8: Commit the tranche.**

  Commit: `feat(cases): add scoped investigations and evidence assertions`

---

### Task 3: Human-reviewed AI suggestions and research queue

**Files:**
- Modify: `src/db/schema/ai.ts`
- Create: `drizzle/0034_ai_review_suggestions.sql` and generated metadata snapshots
- Create: `src/modules/ai/review-types.ts`
- Create: `src/modules/ai/review-validation.ts`
- Create: `src/modules/ai/review-service.ts`
- Modify: `src/modules/ai/graphql.ts`
- Modify: `src/modules/ai/service.ts`
- Modify: `src/graphql/schema.ts`
- Create: `src/graphql/operations/ai-review.graphql`
- Create: `src/components/ai/ai-review-queue.tsx`
- Modify: `src/components/people/person-research-panel.tsx`
- Create: `tests/unit/ai-review-validation.test.ts`
- Create: `tests/unit/ai-review-queue.test.tsx`
- Create: `tests/integration/ai-review-lifecycle.test.ts`
- Modify: `tests/integration/ai-graphql.test.ts`

**Interfaces:**
- Produces `createAiReviewService(context)` with `listSuggestions`, `getSuggestion`, `acceptSuggestion`, `rejectSuggestion`, `deferSuggestion`, and `reviewBatch` methods.
- Produces `AiSuggestionInput` fields `personId`, optional `caseId`, `fieldKey`, proposed typed value, `confidence`, `uncertainty`, `evidenceReferences`, `provider`, `model`, `researchRunId`, and `promptPolicyVersion`.
- Produces GraphQL operations `pendingAiSuggestions`, `acceptAiSuggestion`, `rejectAiSuggestion`, `deferAiSuggestion`, and `reviewAiBatch`; generated operations must return review status and provenance metadata.

- [ ] **Step 1: Write failing unit tests.** Cover required evidence references, valid confidence range, provider/model attribution, rejection reasons, single-field acceptance, batch approval requirement, and refusal to accept an unsupported value type or unsourced relationship.
- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run: `pnpm vitest run tests/unit/ai-review-validation.test.ts tests/unit/ai-review-queue.test.tsx`

  Expected: FAIL because the review schema, service, and queue do not yet exist.

- [ ] **Step 3: Add suggestion records.** Store proposed values as versioned JSON with a typed field reference, source/evidence references, provider/model, research run, confidence/uncertainty, and reviewer decision. The record must preserve the original proposal; acceptance creates or revises a fact/relationship through the existing domain service instead of directly mutating tables.
- [ ] **Step 4: Implement acceptance and rejection rules.** Require purpose coverage for `ai` and `write` actions, verify every evidence reference is visible to the reviewer, require approval for batch acceptance, and emit redacted audit events for every decision. No suggestion may be accepted if its source is missing, its run is incomplete, or its target workspace differs.
- [ ] **Step 5: Add GraphQL and UI.** The queue shows proposed field, current value, evidence snippet, source, confidence, uncertainty, provider/model, and explicit accept/reject/defer controls. The UI must use generated GraphQL documents and never call repositories directly.
- [ ] **Step 6: Regenerate and run integration tests.**

  Run: `pnpm db:generate && pnpm db:check && pnpm db:drift:check && pnpm codegen:check && pnpm vitest run tests/integration/ai-review-lifecycle.test.ts tests/integration/ai-graphql.test.ts`

- [ ] **Step 7: Commit the tranche.**

  Commit: `feat(ai): add provenance-backed human review queue`

---

### Task 4: Privacy requests, retention policies, and legal holds

**Files:**
- Modify: `src/db/schema/privacy.ts`
- Modify: `src/db/schema/enums.ts`
- Create: `drizzle/0035_privacy_retention_controls.sql` and generated metadata snapshots
- Create: `src/modules/privacy/request-types.ts`
- Create: `src/modules/privacy/request-validation.ts`
- Create: `src/modules/privacy/request-service.ts`
- Create: `src/modules/privacy/retention-service.ts`
- Modify: `src/modules/privacy/deletion-executor.ts`
- Modify: `src/modules/privacy/graphql.ts`
- Modify: `src/modules/audit/service.ts`
- Modify: `src/modules/jobs/service.ts`
- Create: `src/graphql/operations/privacy-governance.graphql`
- Modify: `src/graphql/schema.ts`
- Create: `tests/unit/privacy-request-validation.test.ts`
- Create: `tests/unit/retention-service.test.ts`
- Create: `tests/integration/privacy-request-lifecycle.test.ts`
- Create: `tests/integration/retention-legal-hold.test.ts`

**Interfaces:**
- Produces `createPrivacyRequestService(context)` with `createRequest`, `reviewRequest`, `fulfillRequest`, `cancelRequest`, and `getRequest` methods.
- Produces `evaluateRetention(context, resource): Promise<{ state: "retained" | "review_required" | "eligible_for_deletion" | "blocked_by_legal_hold"; policyId: string | null; reason: string }>`.
- Produces `createLegalHold`, `releaseLegalHold`, and `listLegalHolds` operations with reviewer approval and audit references.

- [ ] **Step 1: Write failing state-machine tests.** Cover access, correction, export, restriction, consent withdrawal, and deletion request transitions; requester verification; deadlines; idempotent replay; legal-hold blocking; and completion evidence.
- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run: `pnpm vitest run tests/unit/privacy-request-validation.test.ts tests/unit/retention-service.test.ts`

  Expected: FAIL because the generalized privacy request and retention services do not yet exist.

- [ ] **Step 3: Add privacy request, retention, and legal-hold tables.** Keep existing deletion records readable, migrate them to an explicit request type/state representation, and add processor propagation records for files, search indexes, caches, email, and AI provider references.
- [ ] **Step 4: Implement request authorization and retention evaluation.** Verify the requester, enforce workspace/case scope, require approvals for restricted exports and destructive actions, and prevent deletion while an active legal hold exists. Retention decisions must be deterministic and explainable.
- [ ] **Step 5: Extend GraphQL and jobs.** Add bounded list/mutation operations and a worker that processes only due, approved, non-held resources. Every processor action writes an audit event and a propagation result; failed propagation remains visible and retryable.
- [ ] **Step 6: Run migration, schema, and integration gates.**

  Run: `pnpm db:generate && pnpm db:check && pnpm db:drift:check && pnpm codegen:check && pnpm vitest run tests/integration/privacy-request-lifecycle.test.ts tests/integration/retention-legal-hold.test.ts`

- [ ] **Step 7: Commit the tranche.**

  Commit: `feat(privacy): add governed requests retention and legal holds`

---

### Task 5: Rich profiles, consent-aware research UI, graph evidence states, and documentation

**Files:**
- Modify: `src/app/(app)/people/[personId]/page.tsx`
- Create: `src/components/people/person-governance-panels.tsx`
- Create: `src/components/cases/case-workspace.tsx`
- Modify: `src/components/graph/relationship-editor.tsx`
- Modify: `src/components/graph/graph-view.tsx`
- Modify: `src/components/search/search-panel.tsx`
- Modify: `src/components/people/person-profile-form.tsx`
- Create: `tests/unit/person-governance-panels.test.tsx`
- Create: `tests/unit/case-workspace.test.tsx`
- Create: `tests/unit/person-profile-fields.test.tsx`
- Modify: `tests/unit/graph-accessibility.test.tsx`
- Create: `tests/e2e/consent-governance.spec.ts`
- Create: `tests/e2e/ai-review.spec.ts`
- Modify: `tests/support/fixtures.ts`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DESIGN.md`
- Modify: `TODO.md`
- Create: `docs/operations/consent-governance.md`

**Interfaces:**
- Consumes generated documents from Tasks 1–4; browser components receive typed query results and mutation callbacks, never database repositories.
- Produces a person governance surface with Profile, Facts, Relationships, Evidence, Sources, Timeline, Consent & Purpose, Privacy Requests, and Audit panels.
- Produces visible graph state styling for asserted, corroborated, disputed, disproven, inferred, and inactive relationships.

- [ ] **Step 1: Add synthetic fixtures and failing component tests.** Create fictional names, aliases, pronouns, biographies, employment, education, public contacts, temporal addresses, languages, organizations, public identifiers, notes, custom fields, phones, competing facts, disputed relationships, consent withdrawal, AI suggestions, legal holds, and restricted fields. Assert no fixture contains real personal data or secrets.
- [ ] **Step 2: Implement the governance panels.** Show sensitivity, source, confidence, consent coverage, review state, temporal interval, and audit links on each sensitive field. Missing coverage is a blocking explanation with a link to the consent/purpose flow.
- [ ] **Step 3: Implement case workspace and graph evidence states.** Case membership narrows displayed resources. Edges show state, time range, source count, confidence, and case membership; inferred/disputed edges are visually distinct and cannot be promoted without the review flow.
- [ ] **Step 4: Add consent/purpose indicators to existing search and export entry points.** Existing controls expose whether results and exports are limited by actor, purpose, case, and sensitivity; advanced analysis, import previews, and export-preview UI are implemented in Task 6.
- [ ] **Step 5: Run browser acceptance tests.**

  Run: `pnpm test:e2e tests/e2e/consent-governance.spec.ts tests/e2e/ai-review.spec.ts`

  Expected: all consent, case, graph-state, privacy-request, and AI-review scenarios pass; intentionally unauthorized and withdrawn-consent scenarios show bounded errors without leaking values.

- [ ] **Step 6: Update documentation and acceptance traceability.** Add checked requirements only where the new tests or runtime evidence prove them. Record legacy backfill and hosted migration requirements in `TODO.md`; do not claim production migrations or provider propagation are complete until verified in the target environment.
- [ ] **Step 7: Run the complete local validation suite.**

  Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm db:check && pnpm db:drift:check && pnpm auth:schema:check && pnpm codegen:check && pnpm build`

- [ ] **Step 8: Commit the integration tranche.**

  Commit: `feat(research): add consent-aware case and evidence workspace`

---

### Task 6: Faceted search, controlled imports/exports, and security operations

**Files:**
- Modify: `src/modules/search/service.ts`
- Modify: `src/modules/search/graphql.ts`
- Modify: `src/modules/search/types.ts`
- Create: `src/modules/search/analysis.ts`
- Modify: `src/modules/imports/service.ts`
- Modify: `src/modules/imports/graphql.ts`
- Modify: `src/modules/imports/mapper.ts`
- Modify: `src/modules/imports/validation.ts`
- Create: `src/modules/imports/preview.ts`
- Modify: `src/modules/files/extraction-service.ts`
- Modify: `src/modules/files/extraction-parser.ts`
- Modify: `src/modules/settings/api-key-action-id.ts`
- Modify: `src/modules/settings/administration.ts`
- Modify: `src/modules/audit/service.ts`
- Create: `src/components/search/analysis-panel.tsx`
- Create: `src/components/imports/import-preview.tsx`
- Create: `src/components/exports/export-preview.tsx`
- Modify: `src/db/schema/search.ts`
- Modify: `src/db/schema/files.ts`
- Modify: `src/db/schema/principals.ts`
- Create: `drizzle/0036_search_import_security_controls.sql` and generated metadata snapshots
- Create: `src/graphql/operations/research-analysis.graphql`
- Create: `tests/unit/search-analysis.test.ts`
- Create: `tests/unit/import-preview.test.ts`
- Create: `tests/unit/export-redaction-preview.test.ts`
- Create: `tests/unit/search-analysis-panel.test.tsx`
- Create: `tests/unit/import-preview-panel.test.tsx`
- Create: `tests/unit/export-preview-panel.test.tsx`
- Create: `tests/integration/search-analysis-authorization.test.ts`
- Create: `tests/integration/import-export-governance.test.ts`
- Create: `tests/integration/api-key-security-controls.test.ts`
- Create: `tests/integration/auth-session-security.test.ts`
- Create: `tests/integration/audit-bulk-break-glass.test.ts`

**Interfaces:**
- Produces `searchResearch(context, input)` with bounded facets for `caseId`, `sensitivity`, `consentStatus`, `sourceReliability`, `temporalRange`, `reviewState`, and `relationshipState`.
- Produces `analyzeResearch(context, input)` operations for timeline, source comparison, duplicate candidates, contradiction reports, and explainable graph metrics; each result includes applied filters, limits, and redacted-field counts.
- Produces `previewImport(context, input)` for CSV, JSON, and document extraction with schema mapping, validation issues, duplicate strategy, provenance defaults, and a commit token; no preview writes domain data.
- Produces `previewExport(context, input)` with purpose, case scope, redaction profile, field counts, approval requirement, expiration, and provenance manifest before `commitExport` issues a reference.
- Produces search, import-preview, and export-preview components that consume the generated documents above and never call repositories directly.

- [ ] **Step 1: Write failing search, import/export, panel, and security tests.** Cover bounded faceting, consent/sensitivity filtering, timeline ordering, source comparison, duplicate/contradiction output, explainable metrics, schema-mapping errors, redaction preview, commit-token expiration, API-key scopes/revocation/rate limits, tenant isolation, 2FA, backup codes, session revocation, and mandatory audit attribution.
- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run: `pnpm vitest run tests/unit/search-analysis.test.ts tests/unit/import-preview.test.ts tests/unit/export-redaction-preview.test.ts`

  Expected: FAIL because the analysis and preview interfaces do not yet exist.

- [ ] **Step 3: Implement bounded search analysis.** Reuse existing cursor, complexity, rate, and visibility limits. Apply purpose, case, field-classification, and sensitivity predicates before ranking or aggregation. Every metric explains its source rows, time window, filters, and omitted/redacted fields.
- [ ] **Step 4: Implement controlled import previews.** Parse CSV, JSON, and supported documents into an in-memory preview, run schema mapping and validation, identify possible duplicates without auto-merging, attach provenance defaults, and require an explicit user commit token tied to workspace, purpose, and expiry.
- [ ] **Step 5: Implement redaction-preserving exports.** Generate a preview before writing the export, require purpose and case scope, call governance coverage for every field class, preserve citations and provenance, encrypt the artifact, issue an expiring reference, and record audit/bulk-alert events.
- [ ] **Step 6: Implement the analysis and data-movement panels.** Show applied facets, time windows, source comparison, duplicate/contradiction candidates, metric explanations, import mapping/validation, redaction previews, approval state, expiration, and provenance manifests. The panels must not display omitted restricted values.
- [ ] **Step 7: Harden API keys and operational controls.** Verify scope, workspace binding, expiration, revocation, last-used timestamp, rate limits, tenant isolation, encrypted secret storage, and mandatory audit attribution. Add configurable bulk-query/export alerts and time-bound break-glass approval/review records.
- [ ] **Step 8: Run integration tests and generated checks.**

  Run: `pnpm db:generate && pnpm db:check && pnpm db:drift:check && pnpm codegen:check && pnpm vitest run tests/integration/search-analysis-authorization.test.ts tests/integration/import-export-governance.test.ts tests/integration/api-key-security-controls.test.ts tests/integration/auth-session-security.test.ts tests/integration/audit-bulk-break-glass.test.ts`

- [ ] **Step 9: Commit the tranche.**

  Commit: `feat(analysis): add governed search imports exports and security controls`

---

## Final review and integration checklist

- [ ] Run `git diff --check` and inspect every migration, generated artifact, and authorization branch.
- [ ] Dispatch a task reviewer after each task; resolve every critical/important finding and re-run the focused tests.
- [ ] Dispatch a final whole-branch reviewer against `origin/main` and address load-bearing findings.
- [ ] Run the full validation suite on the merged branch, including database, Compose, browser, security, and generated-drift checks available in CI.
- [ ] Re-read this plan and the design spec line by line; mark any unmet requirement in `TODO.md` rather than claiming completion.
- [ ] Use the finishing-a-development-branch workflow to present integration options; do not push or merge without explicit user direction.
