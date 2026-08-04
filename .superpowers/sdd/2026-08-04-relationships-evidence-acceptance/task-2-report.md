# Task 2 report: source and evidence lifecycle

## Delivered

- Added `archiveSource` and `archiveEvidenceItem` GraphQL mutations with the existing `source:delete` and `evidence:delete` permissions.
- Added version-checked soft-delete lifecycle operations that set `deletedAt`, `deletedBy`, `updatedAt`, `updatedBy`, and increment the resource version.
- Source archival rejects with `PRECONDITION_FAILED` while any non-archived evidence item references that source. The repository archive predicate repeats that guard in the write statement.
- Both archive operations write a redacted audit event, remove the primary search document in the same research transaction, and invalidate visibility-dependent GraphQL loaders.
- Added live GraphQL/PostgreSQL acceptance coverage for the source precondition, evidence-first lifecycle, versioning, tenant isolation, normal-read hiding, soft-delete attribution, audit safety, and search-document removal.

## Validation

- `corepack pnpm typecheck`
- `corepack pnpm exec eslint src/modules/evidence/repository.ts src/modules/evidence/service.ts src/modules/evidence/graphql.ts tests/integration/evidence-lifecycle.test.ts`
- `corepack pnpm exec prettier --check src/modules/evidence/repository.ts src/modules/evidence/service.ts src/modules/evidence/graphql.ts tests/integration/evidence-lifecycle.test.ts`
- Live PostgreSQL: `corepack pnpm test tests/integration/evidence-lifecycle.test.ts --no-file-parallelism` — 1 passed.
- `corepack pnpm build`

The host emitted the existing Node engine warning (project requests Node 24.x; host has Node 26.5.1), but typecheck, live acceptance coverage, and production build all completed successfully.
