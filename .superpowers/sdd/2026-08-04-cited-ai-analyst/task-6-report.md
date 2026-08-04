# Task 6 implementation report

Status: DONE

Commit: `5bb967b6fb704130c61c7ea7d6c5b4d415c9ff1b` (`feat: add cited analyst workspace`)

## Implemented

- Added generated `StartAiAnalysis`, `AiRun`, and `CancelAiAnalysis` browser operations whose shared fragment selects only the public run projection.
- Added a non-disclosing, `analysis:read`-gated `/analyst` route, independently gated start and cancel controls, and permission-aware desktop/mobile navigation and command-menu entries.
- Added bounded question and UUID-scope validation, deliberate-submit idempotency, retry-key reuse limited to one failed submission, duplicate-active-run prevention, bounded exponential polling, abort-safe cancellation, and workspace/unmount cleanup.
- Added accessible queued/running/completed/failed/cancelled states, focus movement at terminal state, provider/model disclosure, safe person citations, non-link evidence citations, and allowlisted count-only tool summaries.
- Updated README, TODO, requirements, architecture, and design evidence without claiming an external provider smoke test, deployment, hosted checks, or production readiness.

## TDD evidence

### Initial RED

```text
mise exec node@24 -- corepack pnpm vitest run tests/unit/analyst.test.tsx
exit 1: tests could not resolve @/components/ai/analyst
```

With isolated Task 6 PostgreSQL and Redis services:

```text
TEST_DATABASE_URL=<isolated-task-6-database> ALLOW_TEST_DATABASE_RESET=true TEST_REDIS_URL=<isolated-task-6-redis> NODE_OPTIONS=--conditions=react-server mise exec node@24 -- corepack pnpm playwright test tests/e2e/analyst.spec.ts
exit 1: 2/2 Chromium cases failed because /analyst had no cited-analyst heading or controls
```

### Cancellation review RED

```text
mise exec node@24 -- corepack pnpm vitest run tests/unit/analyst.test.tsx -t 'cancels an active run and stops polling'
exit 1: the in-flight polling signal was not aborted
```

The implementation now aborts the active read and generation-fences scheduled and settling polls so a stale result cannot overwrite cancellation.

### GREEN

```text
mise exec node@24 -- corepack pnpm vitest run tests/unit/analyst.test.tsx
1 file passed; 8/8 tests passed

TEST_DATABASE_URL=<isolated-task-6-database> ALLOW_TEST_DATABASE_RESET=true TEST_REDIS_URL=<isolated-task-6-redis> NODE_OPTIONS=--conditions=react-server mise exec node@24 -- corepack pnpm playwright test tests/e2e/analyst.spec.ts
2/2 Chromium tests passed
```

The browser cases cover axe, polite progress, terminal focus, permission gating, generated start/read/cancel requests, cancellation, reduced motion, mobile and 200%-equivalent reflow, safe citations, and prompt/provider-private URL, storage, HTML, console, and request leakage assertions.

## Final verification

All commands ran through Node 24 from `/Users/kevo/Projects/humans/.worktrees/mvp-ai-analyst` with isolated Task 6 PostgreSQL and Redis where required.

- `corepack pnpm codegen:check`: passed; analyst generated output was stable after staging the intended generated artifacts.
- `corepack pnpm ci:validate`: passed.
  - Prettier, ESLint, and TypeScript passed.
  - 105 unit files and 901/901 tests passed.
  - Drizzle schema/drift and Better Auth schema checks passed.
  - GraphQL code generation was clean.
  - The license policy approved 433 production package versions.
  - The production audit reported one moderate vulnerability and no high/critical blocking result.
  - The optimized Next.js production build compiled, typechecked, generated 13/13 static pages, and included the dynamic `/analyst` route.
- `git diff --cached --check`: passed before the feature commit.

## Remaining limitations

- No Ollama, OpenAI, or compatible external model endpoint was invoked in Task 6; provider behavior remains covered by the existing deterministic injected-transport tests.
- No Vercel deployment, DNS check, hosted branch-protection/check evidence, optimized runtime-image acceptance, Compose acceptance, or production performance test was performed.
- The repository remains a usable alpha and is not production-ready. Broader incomplete requirements remain in `TODO.md` and `docs/REQUIREMENTS.md`.

Concerns: none within the Task 6 UI slice. The one moderate production dependency audit finding is recorded truthfully and did not meet the repository's high-severity blocking threshold.

## Fix round 1: cancellation recovery and truthful retention status

Fix commit: `d821747f3d880e7124a23cb22ee397219ff5a668` (`fix: resume polling after failed cancellation`)

Two Important review findings were corrected without adding retention functionality:

- A cancellation attempt still aborts and generation-fences the active read. If cancellation cannot be confirmed and the run remains active, a narrow poll revision now restarts bounded polling; the aborted read cannot overwrite the resumed result.
- `HUM-FR-023` is again `Incomplete`, and its exact TODO entry is restored. The read-only tool, authorization, citation, provider/model, and protected error evidence remains recorded, while workspace-policy-controlled omission or retention of restricted prompt content is explicitly unimplemented.

### Fix RED

```text
mise exec node@24 -- corepack pnpm vitest run tests/unit/analyst.test.tsx -t 'resumes polling after cancellation cannot be confirmed'
exit 1: expected the resumed read to be called twice, but polling remained at one call after cancellation failed
```

### Fix GREEN and verification

- The same focused cancellation-recovery test passed: 1/1.
- `corepack pnpm vitest run tests/unit/analyst.test.tsx tests/unit/repository-contract.test.ts`: 2 files and 19/19 tests passed.
- Focused Chromium analyst coverage with isolated PostgreSQL/Redis: 2/2 passed.
- `corepack pnpm ci:validate`: exit 0; format, lint, typecheck, 105 unit files and 902/902 tests, Drizzle checks, Better Auth schema, GraphQL codegen, 433-package production license review, high-severity audit gate, and the optimized production build all passed. The audit continued to report one moderate vulnerability.
- The build retained the dynamic `/analyst` route and generated 13/13 static pages.
- `git diff --check` and the unchanged `tsconfig.json` check passed before the fix commit.

Fix limitations are unchanged: no retention-policy feature was implemented, and no external provider smoke test, deployment, hosted check, or production-readiness claim was made.
