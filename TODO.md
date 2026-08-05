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
- [ ] `HUM-FR-005` Complete live policy/grant/hold/deletion/consent acceptance, retention-worker enforcement, and the full role/resource matrix for the now-implemented audited mutation boundary.
- [ ] `HUM-FR-006` Replace the Better Auth enabled-insert/application staging gap with a fully atomic activation protocol; the current locked lifecycle withholds secrets and performs bounded known-ID cleanup on finalization failure but cannot prove disablement if the first staging write irrecoverably fails.
- [ ] `HUM-FR-010` Complete live identity-candidate, merge/unmerge, tag-collision, external-record, and conflict-matrix acceptance for the bounded reversible reconciliation workflow (implementation now moves non-colliding tags and reversibly fences candidate rows).
- [ ] `HUM-FR-023` Complete workspace-policy-controlled restricted-prompt omission and the full retention-policy matrix beyond implemented AI-thread retention inheritance/purge, read-only tool allowlist, authorization checks, citation validation, and provider/model disclosure.
- [ ] `HUM-FR-024` Complete live webhook lifecycle, signed delivery, retry, destination-rebinding, and upgrade-migration acceptance beyond the implemented durable jobs and immutable audit records.
- [ ] `HUM-FR-028` Complete names/reconciliation, timeline, person-file, and contradictory-fact profile workflows plus full accessibility acceptance beyond the implemented people search/create, overview edit, facts, relationships, evidence, notes, contacts, and activity surfaces. Bounded names/timeline pagination, contradictory-state rendering, and profile RTL/200% keyboard/axe evidence now exist; person-file, reconciliation browser coverage, and the whole-product visual matrix remain open.
- [ ] `HUM-FR-029` Complete graph editing and performance acceptance beyond the existing explorer, accessible table fallback, and Task 12 snapshot/analysis/result/export controls.
- [ ] `HUM-FR-031` Complete mutable/provider administration beyond the Task 14A responsive read-only account, security, members, keys, policies, audit, and integrations settings routes. A focused live policy-settings matrix now covers owner access-policy success, administrator workspace-default success, viewer/foreign denial, optimistic retries, validation rollback, redacted audit output, and one durable `UpdateAccessPolicy` replay/concurrency boundary; provider and whole-settings coverage remain open.
- [ ] `HUM-FR-032` Complete stable errors and request-correlation coverage across the whole MVP beyond the implemented Task 12 search/graph envelopes and the centralized browser/server GraphQL error contract plus representative all-code/redaction matrix.
- [ ] `HUM-FR-033` Complete whole-application failure evidence beyond the implemented dependency readiness, durable retries, worker heartbeat, bounded signal drain, live client/lease checks, and Compose-backed PostgreSQL/Redis outage checks; provider, browser, and interruption coverage remain open.
- [ ] `HUM-FR-035` Build and verify the parity Vercel deployment path.

## Non-functional

- [ ] `HUM-NFR-001` Complete modular-monolith boundary/build evidence beyond Task 12 generated browser operations and shared GraphQL/worker domain services.
- [ ] `HUM-NFR-002` Verify authoritative storage and provider adapter contracts, including external R2/generic-S3/Upstash acceptance. The bounded provider contract suite now exercises every RedisStore operation through local and Upstash-shaped adapters and signed S3-compatible lifecycle/isolation against CI MinIO; real hosted R2, generic S3, and Upstash REST credentials remain required.
- [ ] `HUM-NFR-003` Enforce identifier, tenancy, timestamp, version, and deletion conventions.
- [ ] `HUM-NFR-004` Complete the whole-MVP actor/tenant bypass suite beyond Task 12 authorization-before-ranking and current-authority saved-query/graph reads.
- [ ] `HUM-NFR-005` Complete cookie and whole-MVP GraphQL security controls beyond the Task 12A limiter foundation and Task 12 argument-costed search/snapshot/analysis operation budgets. A bounded live matrix now covers malformed origins/session cookies/API-key headers/JSON and a Redis-backed `graph.read` denial before resolver work; the whole-MVP browser/provider/operation matrix remains open.
- [ ] `HUM-NFR-006` Add input, browser-header, and upload security controls.
- [ ] `HUM-NFR-007` Complete log/audit redaction and protected 2FA handling beyond Task 12 protected-search leakage tests, safe audits, HMAC material controls, and closed production metrics. The bounded NFR-007 tranche now adds `tests/unit/nfr007-redaction-contract.test.ts`, a runtime allowlist in `redactSecurityEvent`, and explicit browser-state wipe coverage for QR/manual secrets and backup codes; the full producer/provider/browser/storage sweep remains required.
- [ ] `HUM-NFR-008` Extend Task 18's durable response-reference replay, expiry takeover, malformed-reference rejection, and concurrent current-primary coverage across every remaining retryable mutation domain. Import `startImport` and the fact-create service transaction seam now have live PostgreSQL replay/concurrency evidence, including malformed and expired opaque references plus tenant fencing. Generated GraphQL `createUploadSession` and `sendWebhookTestEvent` now add the same bounded evidence: concurrent callers converge on one resource, malformed references fail closed before UUID lookup, expired claims take over, and raw-key reuse is tenant-isolated. Generated GraphQL `UpdateAccessPolicy` now adds durable HMAC-bound response replay, corrupted-reference rejection, serialized expiry takeover, concurrent convergence, optimistic-version preservation, and tenant fencing. Direct GraphQL idempotency for people/facts, complete/upload evidence mutations, and the remaining job/settings matrix are still open.
- Bounded HUM-NFR-008 evidence (people create): `createPerson` now supports durable HMAC response-reference replay; live PostgreSQL coverage proves replay without duplicate rows, concurrent convergence, malformed-reference rejection, expiry takeover, and workspace fencing. Generated GraphQL replay is covered; facts, evidence, jobs, and settings mutations remain open.
- [ ] `HUM-NFR-009` Complete responsive and whole-product accessibility acceptance beyond the tested Task 12 search and graph-analysis controls/results. Profile semantic sections, keyboard tab activation, and RTL/200% zoom no-overflow/axe evidence are bounded additions; full responsive primary-journey coverage remains open.
- [ ] `HUM-NFR-011` Complete the remaining whole-product PostgreSQL, Redis, storage, GraphQL, browser, and CI matrix beyond the Task 12 foundation and Task 18 live upgrade/concurrency/browser/Compose suite.
- [ ] `HUM-NFR-012` Complete tenant, auth, security, and deterministic-AI primary journeys beyond the Task 12 search/saved-query/graph browser coverage.
- [ ] `HUM-NFR-018` Produce current full-matrix MVP release evidence.
- [ ] `HUM-NFR-020` Meet and continuously verify the production latency, concurrency, graph-frame-rate, Web Vitals, and bundle budgets beyond Task 12 bounds and indexed-plan evidence.
