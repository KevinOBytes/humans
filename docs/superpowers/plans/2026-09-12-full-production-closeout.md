# Full production closeout

## Context

Humans already has a modular Next.js/GraphQL monolith with PostgreSQL, Redis, MinIO/R2/S3, AI adapters, rich people/facts/relationships/evidence, workspaces/cases, governance, audit, imports, and synthetic fixtures. The current main branch is green but 24 requirements remain incomplete. This plan advances the original full objective without relabeling missing hosted/provider/runtime evidence as complete.

## Global constraints

- Preserve workspace-leading tenant keys, least-privilege authorization, redaction, auditability, idempotency, optimistic versions, and append-only provenance.
- Browser code may only use generated GraphQL operations; repositories remain server/domain-only.
- AI suggestions are never direct writes: every suggestion must retain evidence, uncertainty, provider/model/run attribution, and accept/reject control.
- No threat scores, autonomous adverse decisions, bulk surveillance features, or unconsented real-person data.
- Never commit populated environment files, credentials, dumps, uploads, logs, or agent state.
- Every checked requirement must have focused tests and appropriate live/provider/browser evidence.
- Use TDD and Node 24/pnpm 11.11.0; run format, lint, typecheck, relevant tests, generated drift, and build before commit.
- External provider actions require explicit authorization and redacted evidence; never print or retrieve secret values.

## Tranches

### Task 1 — Governance retention and subject-rights enforcement

Close the highest-risk privacy gaps in HUM-FR-005, HUM-FR-023, HUM-FR-033, and related NFRs: inventory the current retention/legal-hold/deletion implementation, add the smallest missing domain behavior for policy evaluation and subject-rights workflow where absent, preserve legal-hold fencing and audit redaction, and add live PostgreSQL/worker tests. Do not claim provider/browser closure unless evidence exists.

### Task 2 — Remaining retryable mutation/idempotency matrix

Audit HUM-NFR-008 and remaining people/settings/retryable mutations. Add durable principal-bound idempotency and conflict/replay coverage to the next concrete mutation family without weakening legacy callers or tenant isolation. Generated GraphQL, service, repository, and live PostgreSQL tests are required.

### Task 3 — Rich profile and provenance acceptance matrix

Audit HUM-FR-008/009/012/013/015/016/028 against the requested rich-profile fields, temporal graph semantics, contradiction handling, field-level provenance, and reviewed AI enrichment. Add only missing schema/service/UI behavior and focused GraphQL/browser tests; preserve documented-vs-hypothesis distinction.

### Task 4 — External/hosted release evidence

Run a redacted production readiness audit for HUM-FR-003/035 and HUM-NFR-002/011/018: verify current Vercel deployment identity, safe health/auth boundaries, configured provider topology, and available external adapter contracts. Implement only missing safe smoke harness or configuration validation; do not export secrets or mark hosted authenticated/provider acceptance complete without direct evidence.

### Task 5 — Final whole-branch review and release ledger

Run the complete current quality matrix, reconcile REQUIREMENTS/TODO evidence, perform a whole-branch security/architecture review, and record remaining blockers explicitly.
