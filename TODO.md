# MVP closure and production hardening backlog

The usable self-hosted alpha and MVP release-candidate boundary is documented in
`docs/releases/SELF_HOSTED_ALPHA.md`. Every incomplete requirement is listed
exactly once below. Full MVP completion still requires the full current matrix
and the release evidence required by `HUM-NFR-018`; the alpha label does not
reclassify any design requirement as post-MVP. Remove an item only in the same
change that updates `docs/REQUIREMENTS.md` to **Complete** and records passing
test or runtime evidence.

`HUM-FR-017` remains complete and intentionally absent: PostgreSQL integration
coverage includes the short-transaction upload-attempt fence, non-blocking
cancellation, late-object cleanup, successful completion, and lease-expiry
recovery.

## Functional

- [ ] `HUM-FR-003` Complete hosted release evidence and recovery acceptance for the implemented explicit, idempotent administrator bootstrap.
- [ ] `HUM-FR-004` Complete the recipient acceptance, administrator-role, resend/removal, responsive/RTL/zoom, provider-failure, and cancel/acceptance race matrix for the implemented workspace invitation and member-management boundary.
- [ ] `HUM-FR-005` Complete policy mutation, grants, holds, deletion, and consent beyond the Task 14A typed read-only workspace/access/retention posture.
- [ ] `HUM-FR-006` Replace the Better Auth enabled-insert/application staging gap with a fully atomic activation protocol; the current locked lifecycle withholds secrets and performs bounded known-ID cleanup on finalization failure but cannot prove disablement if the first staging write irrecoverably fails.
- [ ] `HUM-FR-007` Extend the executable generated-operation/readback matrix to contacts/locations, settings members/API keys/audit, dashboard, and graph analysis before claiming whole-product canonical GraphQL coverage.
- [ ] `HUM-FR-008` Complete explicit full-contract acceptance for the implemented stable person records and presentation selections, including merge-target and accepted name/photo behavior.
- [ ] `HUM-FR-010` Complete identity support and reversible merge workflows beyond the Task 12A protected-identifier normalization and exact-lookup foundation.
- [ ] `HUM-FR-018` Implement extraction-run execution beyond the implemented access-controlled, idempotent CSV/JSON import preparation, execution, diagnostics, and retry boundary.
- [ ] `HUM-FR-019` Complete optional embedding support and final release/Compose proof beyond the implemented Task 12 transactional PostgreSQL full-text, structured, and protected-exact search slice.
- [ ] `HUM-FR-020` Complete the full saved-query/view release matrix beyond the implemented closed saved-search AST, ownership/sharing, current-authority runs, graph views, and immutable snapshot manifests.
- [ ] `HUM-FR-023` Implement workspace-policy-controlled restricted-prompt omission/retention beyond the implemented read-only tool allowlist, authorization checks, citation validation, and provider/model disclosure.
- [ ] `HUM-FR-024` Implement webhook lifecycle, signed delivery, retry execution, and acceptance coverage beyond the implemented durable jobs, immutable audit events, and idempotency records.
- [ ] `HUM-FR-025` Complete meaningful mutation/readback and failure-boundary coverage for the remaining contacts/locations, settings administration/audit, dashboard, and graph-analysis GraphQL inventory.
- [ ] `HUM-FR-028` Complete names/reconciliation, timeline, person-file, and contradictory-fact profile workflows plus full accessibility acceptance beyond the implemented people search/create, overview edit, facts, relationships, evidence, notes, contacts, and activity surfaces.
- [ ] `HUM-FR-029` Complete graph editing and performance acceptance beyond the existing explorer, accessible table fallback, and Task 12 snapshot/analysis/result/export controls.
- [ ] `HUM-FR-031` Complete mutable/provider administration beyond the Task 14A responsive read-only account, security, members, keys, policies, audit, and integrations settings routes.
- [ ] `HUM-FR-032` Complete stable errors and request-correlation coverage across the whole MVP beyond the implemented Task 12 search and graph envelopes.
- [ ] `HUM-FR-033` Complete whole-application failure evidence beyond the implemented dependency readiness, durable retries, worker heartbeat, and bounded signal drain.
- [ ] `HUM-FR-034` Pin and verify the remaining Compose service manifest-list digests beyond the implemented digest-pinned Distroless application image and private, authenticated, persistent, health-gated lifecycle.
- [ ] `HUM-FR-035` Build and verify the parity Vercel deployment path.
- [ ] `HUM-FR-036` Complete cross-mode worker-contract and Redis lease-concurrency runtime evidence for the implemented shared durable executor, continuous Docker worker, and bounded scheduled route.
- [ ] `HUM-FR-037` Add opt-in Ollama service and model initialization.

## Non-functional

- [ ] `HUM-NFR-001` Complete modular-monolith boundary/build evidence beyond Task 12 generated browser operations and shared GraphQL/worker domain services.
- [ ] `HUM-NFR-002` Verify authoritative storage and provider adapter contracts.
- [ ] `HUM-NFR-003` Enforce identifier, tenancy, timestamp, version, and deletion conventions.
- [ ] `HUM-NFR-004` Complete the whole-MVP actor/tenant bypass suite beyond Task 12 authorization-before-ranking and current-authority saved-query/graph reads.
- [ ] `HUM-NFR-005` Complete cookie and whole-MVP GraphQL security controls beyond the Task 12A limiter foundation and Task 12 argument-costed search/snapshot/analysis operation budgets.
- [ ] `HUM-NFR-006` Add input, browser-header, and upload security controls.
- [ ] `HUM-NFR-007` Complete log/audit redaction and protected 2FA handling beyond Task 12 protected-search leakage tests, safe audits, HMAC material controls, and closed production metrics.
- [ ] `HUM-NFR-008` Extend Task 18's durable response-reference replay, expiry takeover, malformed-reference rejection, and concurrent current-primary coverage across every remaining retryable mutation domain.
- [ ] `HUM-NFR-009` Complete responsive and whole-product accessibility acceptance beyond the tested Task 12 search and graph-analysis controls/results.
- [ ] `HUM-NFR-011` Complete the remaining whole-product PostgreSQL, Redis, storage, GraphQL, browser, and CI matrix beyond the Task 12 foundation and Task 18 live upgrade/concurrency/browser/Compose suite.
- [ ] `HUM-NFR-012` Complete tenant, auth, security, and deterministic-AI primary journeys beyond the Task 12 search/saved-query/graph browser coverage.
- [ ] `HUM-NFR-013` Complete the optional Ollama/model smoke beyond the implemented isolated production-image base-stack smoke and lifecycle drills.
- [ ] `HUM-NFR-018` Produce current full-matrix MVP release evidence.
- [ ] `HUM-NFR-020` Meet and continuously verify the production latency, concurrency, graph-frame-rate, Web Vitals, and bundle budgets beyond Task 12 bounds and indexed-plan evidence.
