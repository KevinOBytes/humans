# MVP requirement backlog

Every incomplete MVP requirement is listed exactly once. Check an item only in the same change that updates `docs/REQUIREMENTS.md` to **Complete** and records passing test or runtime evidence.

## Functional

- [ ] `HUM-FR-003` Complete hosted release evidence and recovery acceptance for the implemented explicit, idempotent administrator bootstrap.
- [ ] `HUM-FR-004` Complete the recipient acceptance, administrator-role, resend/removal, responsive/RTL/zoom, provider-failure, and cancel/acceptance race matrix for the implemented workspace invitation and member-management boundary.
- [ ] `HUM-FR-005` Complete policy mutation, grants, holds, deletion, and consent beyond the Task 14A typed read-only workspace/access/retention posture.
- [ ] `HUM-FR-006` Replace the Better Auth enabled-insert/application staging gap with a fully atomic activation protocol; the current locked lifecycle withholds secrets and performs bounded known-ID cleanup on finalization failure but cannot prove disablement if the first staging write irrecoverably fails.
- [ ] `HUM-FR-007` Implement the canonical GraphQL application API and generated operations.
- [ ] `HUM-FR-008` Implement stable person records and presentation selections.
- [ ] `HUM-FR-010` Complete identity support and reversible merge workflows beyond the Task 12A protected-identifier normalization and exact-lookup foundation.
- [ ] `HUM-FR-015` Implement temporal social relationship types and edges.
- [ ] `HUM-FR-016` Implement sources, evidence, excerpts, notes, and tags.
- [ ] `HUM-FR-017` Implement private file and upload-session lifecycle.
- [ ] `HUM-FR-018` Implement idempotent CSV/JSON imports and extraction runs.
- [ ] `HUM-FR-019` Complete optional embedding support and final release/Compose proof beyond the implemented Task 12 transactional PostgreSQL full-text, structured, and protected-exact search slice.
- [ ] `HUM-FR-020` Complete the full saved-query/view release matrix beyond the implemented closed saved-search AST, ownership/sharing, current-authority runs, graph views, and immutable snapshot manifests.
- [ ] `HUM-FR-021` Record full-matrix runtime evidence for the implemented bounded Degree, PageRank, and Louvain analyses, reproducibility replay, typed results/person metrics, and safe JSON/CSV exports.
- [ ] `HUM-FR-023` Restrict AI tools and require authorized cited answers.
- [ ] `HUM-FR-024` Implement durable jobs, audit, idempotency, and webhooks.
- [ ] `HUM-FR-025` Complete the whole-MVP GraphQL operation and production-introspection matrix beyond the generated Task 12 search, saved-query, snapshot/replay, deterministic analysis, and export operations.
- [ ] `HUM-FR-027` Build workspace setup and dashboard surfaces.
- [ ] `HUM-FR-028` Build people and evidence-rich profile surfaces.
- [ ] `HUM-FR-029` Complete graph editing and performance acceptance beyond the existing explorer, accessible table fallback, and Task 12 snapshot/analysis/result/export controls.
- [ ] `HUM-FR-031` Complete mutable/provider administration beyond the Task 14A responsive read-only account, security, members, keys, policies, audit, and integrations settings routes.
- [ ] `HUM-FR-032` Complete stable errors and request-correlation coverage across the whole MVP beyond the implemented Task 12 search and graph envelopes.
- [ ] `HUM-FR-033` Complete whole-application failure evidence beyond the implemented dependency readiness, durable retries, worker heartbeat, and bounded signal drain.
- [ ] `HUM-FR-034` Pin and verify the remaining Compose service manifest-list digests beyond the implemented digest-pinned Distroless application image and private, authenticated, persistent, health-gated lifecycle.
- [ ] `HUM-FR-035` Build and verify the parity Vercel deployment path.
- [ ] `HUM-FR-036` Implement the shared durable-job executor and Redis leases.
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
