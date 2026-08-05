# File upload-session idempotency

## Goal

Extend the existing durable research idempotency contract to one remaining
file mutation without changing the schema or claiming whole-product NFR-008
completion.

## Scope

- Accept an optional client idempotency key on `createUploadSession`.
- Persist only an opaque upload-session response reference in the existing
  `idempotency_keys` ledger; the signed storage grant remains regenerated from
  the authorized session.
- Keep the ordinary no-key upload path unchanged.
- Add live PostgreSQL/generated GraphQL coverage for concurrent convergence,
  malformed-reference fail-closed behavior, expiry takeover, and workspace
  isolation.

## Verification

```sh
TEST_DATABASE_URL='postgres://humans:humans_test@127.0.0.1:55441/humans_test' \
ALLOW_TEST_DATABASE_RESET=true \
pnpm vitest run tests/integration/graphql-product-files-imports.test.ts --no-file-parallelism
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Direct GraphQL idempotency for complete/upload evidence mutations and the
remaining people, fact, job, and settings mutation matrix remain open.
