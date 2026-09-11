# Task 2 backend implementation checkpoint

## Implemented

- Workspace-scoped cases, principal membership, resource links, versioned evidence assertions, and independent assertion-review records.
- Case memberships intersect baseline resource visibility in shared SQL and ID-based authorization paths; case links cannot grant access. Links and assertions support person, fact, and relationship targets, with an allowlisted PostgreSQL trigger enforcing the resource workspace.
- Case creation, membership, resource linking, bounded case listing/timeline, assertion linking/review, and generated GraphQL operations. Timeline reads recheck current subject coverage and baseline visibility.
- Assertions resolve source/evidence and target in one workspace, call current purpose coverage for all target subjects, retain bounded quote/locator/confidence, and audit changed field names without quote/locator content. No encrypted payload is selected.
- Relationships expose case, observation time, creation method, review state, and existing temporal intervals. New case/AI/provenance creation paths require confirmation. Existing manual creation remains compatible. Inferred-to-asserted/corroborated promotion requires a supporting assertion, independent human approval, reviewer permission, explicit confirmation, matching purpose/case, and assertion/resource-version binding. Existing idempotent relationship request material includes provenance inputs.
- Migration `0033_cases_and_evidence_assertions.sql`, Drizzle metadata, generated GraphQL artifacts, schema inventory updates, and focused/gated integration tests.

## Exact local evidence

Commands used `PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH` and pnpm 11.11.0, except the initial RED invocation ran the host default Node 26 before the mismatch was identified.

- RED: focused case/assertion unit invocation failed because both new validation modules were absent.
- GREEN: `pnpm vitest run tests/unit/cases-validation.test.ts tests/unit/evidence-assertions.test.ts`: 2 files, 6 tests passed.
- `pnpm db:generate`: generated migration 0033 and a 90-table snapshot; renamed generated SQL/journal tag to the required descriptive name and added the polymorphic workspace guard.
- `pnpm db:check`: passed.
- `pnpm db:drift:check`: passed.
- `pnpm codegen`: passed.
- `pnpm codegen:check`: passed with generated changes staged, verifying a second generation did not alter the generated index contents.
- `pnpm lint`: final run passed without warnings. An earlier unused import warning was corrected.
- `pnpm typecheck`: final run passed.
- `pnpm test:unit`: 150 files, 1163 tests passed.
- Focused units plus schema and gated API/provenance/product acceptance: 4 files / 124 tests passed, 3 files / 19 tests skipped. After adding the generated case acceptance scenario, `pnpm vitest run tests/integration/cases-api.test.ts tests/integration/relationship-provenance.test.ts tests/integration/graphql-product-acceptance.test.ts` reported 3 files / 20 tests skipped.
- `pnpm build`: passed, including TypeScript and static page generation.
- `pnpm format:check`: final run passed. Initial full formatting check identified five new files; they were formatted and the full check rerun.
- `pnpm start --port 3217`: Ready; local root HTTP smoke returned 200. Next warned to use the standalone entrypoint for standalone deployments; this is only a local process/root-route smoke, not deployment evidence.
- `git diff --check`: passed before final documentation update.

## Explicitly open evidence and scope

### Review correction: disputed-state promotion bypass

The initial implementation incorrectly gated review only when the current state
was `inferred`, allowing `inferred -> disputed -> corroborated` to bypass review.
The follow-up uses one shared predicate for both relationship update and approval
verification: entry into a documented state from a different state requires the
review bundle unless persisted review status is already approved; a direct
inferred promotion always requires it. Unchanged documented-state edits remain
compatible. Approval checks still bind assertion and resource versions.

TDD evidence: the new unit regressions first failed (2 failures), then passed.
The focused case/assertion invocation passed 9 unit tests; 5 PostgreSQL provenance
tests, including the disputed-state denial and reviewed-success workflow, were
skipped because `TEST_DATABASE_URL` remains absent. Fresh Node 24 lint, full
formatting check, typecheck, and production build passed. New case/assertion
mutation idempotency remains open and was not folded into this state-machine fix.

`TEST_DATABASE_URL` is absent. No disposable PostgreSQL lifecycle, migration execution, GraphQL membership/provenance approval, or rollback behavior is claimed verified. The tests are gated and must run against a disposable migrated database before release. No production database, provider, or deployment was changed.

This is a coherent backend checkpoint, not full Task 2 acceptance. The additional case/resource authorization joins need live query/graph/search regression and performance evidence. Timeline pages are bounded underlying link pages and may be sparse after current authorization. Assertion reviews currently support relationships only. Source/evidence/file/note case targets are not exposed because they do not yet have a safe covered-subject contract. Case member removal/archive UI, dedicated assertion read history, and new case/assertion mutation idempotency are follow-on work; no requirement checkbox is closed. Task 1's recorded outstanding governance limitations remain outstanding.
