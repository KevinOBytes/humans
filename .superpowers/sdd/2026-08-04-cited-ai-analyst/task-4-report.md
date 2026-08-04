# Task 4 report: authorized durable AI execution handler

## Status

Complete. The production worker registry now installs a real `ai_execute` handler. The executor remains the sole owner of durable job completion.

Per the parent maintainability decision, the new execution cases live in the focused `tests/integration/ai-worker.test.ts` suite; the existing approximately 1,100-line `worker-research-transactions.test.ts` remains unchanged.

## Implementation

- Added `createAiAnalysisHandler(runtime)` with the exact four-tool static dispatcher: `getEvidence`, `getPerson`, `searchGraph`, and `searchPeople`.
- Capped provider turns and tool calls at four, mapped upstream failures to stable codes, and persisted only allowlisted count/boolean summaries.
- Fenced provider configuration and protected prompt content with existing HMAC primitives.
- Reauthorized the exact claim, run, principal, full protected scope, lease, and current `analysis:read`/`analysis:run` authority before every provider boundary, tool invocation, tool trace, and final write.
- Extended the Task 3 repository with the narrow claim-bound current-authority primitive while preserving job/run -> authority -> sorted resource -> grant/policy lock order.
- Built citations only from successful tool-returned resource references, then revalidated current visibility and the persisted returned-resource ledger in the final transaction.
- Added exactly-once replay recognition for a completed run whose executor has not yet completed its durable job.
- Replaced the runtime placeholder with the configured provider and the existing people, evidence, search, and graph services under a freshly authorized research context.

No GraphQL, generated client, or UI code was added.

## TDD evidence

RED before the implementation:

```text
mise exec node@24.19.0 -- corepack pnpm vitest run tests/integration/ai-worker.test.ts --no-file-parallelism
exit 1: Cannot find package '@/worker/handlers/ai-analysis'
0 tests collected
```

GREEN after the implementation:

```text
ALLOW_TEST_DATABASE_RESET=true TEST_DATABASE_URL=postgresql://humans_test:humans_test@127.0.0.1:55432/humans_auth_test mise exec node@24.19.0 -- corepack pnpm vitest run tests/integration/worker-research-transactions.test.ts tests/integration/ai-worker.test.ts tests/integration/ai-analysis.test.ts --no-file-parallelism
3 files passed; 56 tests passed; 43.10s; exit 0
```

The injected fake-provider/Redis cases cover authorized tool-to-answer execution, exact dispatcher names, executor-owned completion, membership revocation between provider request and tool invocation, forged/unreturned citations, scope removal before final write, the four-call boundary, five executor retries and dead-letter redaction, cancellation during generation, lease-renewal loss, pre-abort, and exactly-once replay. Revocation, cancellation, abort, and lease-loss cases assert that no stale tool trace or assistant output is persisted.

## Final verification

```text
mise exec node@24.19.0 -- corepack pnpm format:check
All matched files use Prettier code style; exit 0

mise exec node@24.19.0 -- corepack pnpm lint
exit 0

mise exec node@24.19.0 -- corepack pnpm typecheck
exit 0

mise exec node@24.19.0 -- corepack pnpm test:unit
104 files passed; 893 tests passed; 7.82s; exit 0

mise exec node@24.19.0 -- corepack pnpm build
Next.js production build compiled, typechecked, and generated 13/13 static pages; exit 0

git diff --check
exit 0
```

## Concerns

None. Tests use deterministic injected providers and do not call an external model endpoint.
