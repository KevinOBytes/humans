# SDD ledger — plan: docs/superpowers/plans/2026-09-11-consent-governed-investigative-research-plan.md

## Plan scan and rulings

| Tasks | Shared file or interface | Finding | Ruling |
| --- | --- | --- | --- |
| 1 and 2 | `src/db/schema/index.ts`, migration metadata, generated GraphQL | Task 2 depends on governance coverage and the schema export created by Task 1. | Execute sequentially; Task 2 may consume only the committed Task 1 interfaces and regenerated artifacts. |
| 1 and 3 | `checkPurposeCoverage`, audit transactions, GraphQL context | AI acceptance must use the same coverage and audit boundary as ordinary fact writes. | Task 3 consumes the exact Task 1 function signature and cannot duplicate coverage logic. |
| 1 and 4 | `src/db/schema/privacy.ts`, consent withdrawal, privacy request state | Consent withdrawal can trigger privacy processing but must not delete synchronously. | Task 1 records coverage/withdrawal; Task 4 owns asynchronous effect and propagation. |
| 2 and 3 | evidence assertions, facts/relationships, generated operations | AI suggestions need evidence links and case scope before acceptance. | Task 3 consumes Task 2 evidence assertion interfaces and rejects unsourced proposals. |
| 2 and 5 | relationship metadata, graph UI, case links | UI needs the relationship state and case visibility added by Task 2. | Task 5 consumes Task 2 GraphQL results and preserves explicit confirmation. |
| 3 and 5 | AI review queue and person research panel | The queue requires generated AI review documents before browser integration. | Task 3 owns operations; Task 5 owns person-page placement and e2e coverage. |
| 4 and 6 | privacy requests, redaction, export references | Export preview needs retention/legal-hold and request state from Task 4. | Task 6 calls Task 4 services and cannot issue references while a hold blocks them. |
| 5 and 6 | search entry points and analysis panels | Task 5 adds consent indicators; Task 6 adds advanced analysis/import/export panels. | Keep responsibilities separate; Task 5 must not invent Task 6 operations. |
| 1 | governance modules and tests | Tests, service, GraphQL, migration, and docs are all listed within the task. | Self-consistent; no cross-task interface is required to begin. |
| 2 | case/evidence modules and tests | Relationship changes and evidence assertions share a workspace boundary. | Self-consistent; use one transaction and existing relationship state transitions. |
| 3 | AI schema/service/UI and tests | Acceptance mutates domain resources through existing services rather than direct writes. | Self-consistent; preserve original suggestion records. |
| 4 | privacy schema/service/jobs and tests | Retention evaluation and worker processing are both specified. | Self-consistent; legal holds are checked in both mutation and worker paths. |
| 5 | profile/graph UI and synthetic fixtures | The listed fixture fields match the profile and graph acceptance requirements. | Self-consistent; no real-person fixture data. |
| 6 | search/import/export/security modules and tests | Backend interfaces and browser panels are listed together. | Self-consistent; previews are side-effect free until explicit commit. |

### Rulings

- Ruling: Use the existing modular-monolith boundaries and add tables/modules rather than rewrite the core schema — this preserves current authorization and migration evidence; the cost is more joins and migration coordination.
- Ruling: Treat `analyst_hypothesis` as a first-class assertion kind but never as an accepted fact/relationship state — this satisfies analyst workflow while preventing inference from becoming truth automatically.
- Ruling: Keep Task 5 before Task 6 for profile/graph integration, and keep advanced search/import/export operations in Task 6 — this removes the original UI/API ordering ambiguity; the cost is that the final UI tranche is split across two tasks.
- Ruling: Existing 2FA, backup codes, API-key revocation, encryption, and session controls are regression-tested and reused rather than reimplemented — this avoids weakening mature security code; the cost is less new code in Task 6.

## Task ledger

- BASE before Task 1 dispatch: `8890c44ff2cdf2d387dd912c859946055e51e8cc`.
- Task 1: implementation tranche complete but review FAIL remains. Commits eae815c, fd2890f, ceef80e, 9847553, 4dac78a, 62d6ae9, f801c0c, e437aee. Source-level governance enforcement now covers consent normalization, effective sensitivity, fact writes/revisions, person-scoped AI, restricted evidence binding, principal-bound restricted fact reads, approval transitions/listing, deterministic policy precedence, and audit. Focused/full local checks pass under Node 24 (148 files / 1157 unit tests); PostgreSQL lifecycle tests are gated because TEST_DATABASE_URL is absent. Remaining Task 1 gaps: standalone governance mutation idempotency and live PostgreSQL lifecycle evidence. Do not mark Task 1 fully complete until those gaps are closed.
- Task 2: backend checkpoint implemented; commit message `feat(cases): add scoped investigations and evidence assertions`. Case membership/resource narrowing, assertions/review records, temporal/provenance relationship metadata, generated GraphQL, migration 0033, and tests are included. Node 24 unit suite passes (150 files / 1163 tests); format, lint, typecheck, production build, DB metadata/drift, and generated checks pass. Local root HTTP smoke returned 200. Three requested live integration files / 20 tests are explicitly skipped because `TEST_DATABASE_URL` is absent. Full Task 2 acceptance remains open pending PostgreSQL lifecycle and browser/runtime evidence and the scoped follow-ons in `task-2-report.md`.
- Task 3: pending.
- Task 4: pending.
- Task 5: pending.
- Task 6: pending.
- Final whole-branch review: pending.
