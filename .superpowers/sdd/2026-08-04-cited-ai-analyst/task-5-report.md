# Task 5 implementation report

Status: DONE

Commit: `57db45be3d7c85e39c7ad24ea339ebcd92c112c8` (`feat: expose cited AI analysis through GraphQL`)

## Implemented

- Added the canonical Pothos/Yoga `startAiAnalysis`, `aiRun`, and `cancelAiAnalysis` fields.
- Reused the existing AI analysis service for principal-bound persistence, live authorization, idempotency, cancellation, and public projections.
- Added closed inputs, stable enums, bounded fixed-cost fields, operation admission, public citation fields, and count-only tool summaries.
- Wired the validated production AI provider disclosure/fingerprint and encryption/HMAC runtime through the existing route, server, context, and service construction path.
- Extended the existing GraphQL integration fixture with a deterministic provider identity seam. Request handling never invokes provider execution.
- Added live PostgreSQL coverage for authenticated users and API keys, principal attribution, permissions, non-disclosure, idempotency conflicts, request correlation, validated citations, redacted summaries, schema absence of protected fields, global alias/complexity limits, and stable provider-admission errors.

## TDD evidence

### RED

Command (Node 24; credentials were injected from the isolated local test PostgreSQL container and were not persisted):

```bash
TEST_DATABASE_URL=<isolated-live-test-database> ALLOW_TEST_DATABASE_RESET=true mise exec node@24.19.0 -- corepack pnpm vitest run tests/integration/ai-graphql.test.ts --no-file-parallelism
```

Result before implementation: exit 1; 1 test file failed and 7/7 tests failed. The first operation reported `Unknown type "AiRun"`, `Unknown type "StartAiAnalysisInput"`, and `Cannot query field "startAiAnalysis" on type "Mutation"`, which was the expected missing-surface failure.

### GREEN

Same command after implementation: exit 0; 1 test file passed and 7/7 tests passed in 6.25 seconds.

## Verification

All commands ran through Node 24 (`mise exec node@24.19.0 --`) from `/Users/kevo/Projects/humans/.worktrees/mvp-ai-analyst`.

- `corepack pnpm vitest run tests/integration/ai-graphql.test.ts tests/integration/graphql-context.test.ts tests/integration/graphql-limits.test.ts tests/integration/graphql-operation-limiter.test.ts tests/integration/tenant-isolation.test.ts --no-file-parallelism` with the isolated live test database: exit 0; 5 files and 44/44 tests passed.
- `corepack pnpm codegen`: exit 0; generation completed with no generated client diff.
- `corepack pnpm typecheck`: exit 0.
- `corepack pnpm lint`: exit 0.
- `corepack pnpm format:check`: exit 0; all files matched Prettier style.
- `corepack pnpm test:unit`: exit 0; 104 files and 893/893 tests passed.
- `corepack pnpm build`: exit 0; optimized Next.js build compiled, TypeScript completed, and 13/13 static pages generated.
- `git diff --check`: exit 0.

## Files changed

- `src/modules/ai/graphql.ts`
- `src/graphql/context.ts`
- `src/graphql/loaders.ts`
- `src/graphql/schema.ts`
- `src/graphql/server.ts`
- `src/app/api/graphql/route.ts`
- `tests/support/graphql.ts`
- `tests/integration/ai-graphql.test.ts`

## Self-review and concerns

Self-review found no out-of-scope UI, documentation, browser-operation, or generated-client changes. No provider work is performed in a GraphQL request, and the schema exposes no prompt, encryption, provider transport, key, URL/fingerprint, job, raw tool, upstream response, or internal error fields.

Concerns: none.

## Fix round 1: exact mutation permissions

Fix commit: `8df7366276863f0f49cef674219049a0fe9cd5a9` (`fix: enforce exact AI mutation permissions`)

An Important review finding identified that the service added `analysis:read` to both mutation contracts. The service now uses a private owned-run projection helper parameterized by the operation's already-required permission bundle: start uses `analysis:create` plus `analysis:run` (and any scope-specific resource-read permission), cancel uses `analysis:cancel`, and the public `readAiRun` operation remains independently gated by `analysis:read`.

### Fix RED

The focused live PostgreSQL command above failed with 1 expected failure and 7 passing tests. An API key with exactly `analysis:create` and `analysis:run` received a correlated `FORBIDDEN` response from `startAiAnalysis`, proving the hidden read dependency.

### Fix GREEN and verification

- Focused live GraphQL suite: 1 file and 8/8 tests passed.
- `corepack pnpm vitest run tests/integration/ai-graphql.test.ts tests/integration/ai-analysis.test.ts --no-file-parallelism` with the isolated live test database: 2 files and 34/34 tests passed.
- `corepack pnpm codegen`: passed with no generated client changes.
- `corepack pnpm format:check`, `corepack pnpm lint`, and `corepack pnpm typecheck`: passed.
- `corepack pnpm test:unit`: 104 files and 893/893 tests passed.
- `corepack pnpm build`: optimized production build passed, including TypeScript and 13/13 static pages.
- `git diff --check`: passed.

Fix concerns: none. The new regression proves exact API-key mutation permission sets while ordinary reads remain denied without `analysis:read`; the existing authenticated-user, principal-isolation, and cross-workspace tests remain green.
