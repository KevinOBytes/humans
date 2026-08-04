# Cited AI Analyst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a usable, workspace-authorized AI analyst that runs through the canonical GraphQL API, supports OpenAI/Ollama/OpenAI-compatible providers, persists protected runs and cited results, and executes through the existing durable worker.

**Architecture:** Extend the existing PostgreSQL/Redis durable-job boundary with one `ai_execute` job kind. A provider-neutral adapter speaks the OpenAI chat-completions protocol through an injectable transport; the model can request only four static read-only domain tools. GraphQL creates and reads runs, the worker re-authorizes every operation and persists a single fenced result, and the browser polls generated operations for progress and renders only validated citations and redacted tool summaries.

**Tech Stack:** Next.js 16, TypeScript, Pothos/GraphQL Yoga, GraphQL Code Generator, Drizzle/PostgreSQL, Redis leases, Node HTTP(S), Tailwind CSS, Vitest, Playwright.

## Global Constraints

- GraphQL Yoga at `/api/graphql` remains the canonical application-data API; browser code uses generated operations and never imports repositories.
- Support `openai`, `ollama`, and `compatible` OpenAI chat-completions providers without exposing API keys or base URLs to GraphQL, logs, audits, jobs, traces, or client bundles.
- The static tool allowlist is exactly `getEvidence`, `getPerson`, `searchGraph`, and `searchPeople`; tools call authorized domain services only and never expose SQL, arbitrary GraphQL, network, filesystem, or mutation capabilities.
- Every start/read/cancel/tool/result operation is workspace-scoped and re-authorizes the current user or API-key principal. API-key starts are principal-attributed; no AI row or job may be silently unattributed.
- Prompts, answers, and job payloads are encrypted with the existing sealed-envelope boundary. Content, prompt, and configuration digests use domain-separated HMAC with `DATA_ENCRYPTION_KEY`, never raw SHA-256 of low-entropy text.
- Model citations are untrusted until they reference a resource returned by an allowed tool in the same run and remain visible in the same workspace at persistence/read time.
- Provider requests reject redirects. OpenAI uses only canonical `https://api.openai.com/v1`; compatible endpoints are HTTPS without userinfo/query/fragment and connect only to a prevalidated public DNS address; Ollama HTTP is accepted only for the configured Docker service (or loopback tests).
- Provider errors return only stable public codes/messages and request IDs. Upstream bodies, headers, prompts, keys, URLs, and stack text are never copied into expected GraphQL errors.
- Existing job claim-generation fencing and Redis leases remain authoritative. Final assistant message, citations, and tool trace persist idempotently once; a stale worker cannot commit them.
- The ordinary Compose stack must not download or require Ollama. The existing opt-in `docker-compose.ollama.yml` profile remains the only model initialization path.
- Do not mark composite requirements complete unless their entire verification text is proven. Update `TODO.md` and `docs/REQUIREMENTS.md` only for the exact AI rows this plan fully closes.

---

### Task 1: Secure provider adapter and authorized tool contract

**Files:**
- Create: `src/modules/ai/provider.ts`
- Create: `src/modules/ai/tools.ts`
- Create: `src/modules/ai/types.ts`
- Modify: `src/lib/env/server-schema.ts`
- Test: `tests/unit/ai-provider.test.ts`
- Test: `tests/unit/ai-tools.test.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `AiProviderRuntime`, `AiProvider`, `AiProviderTurn`, `createAiProvider(runtime)`, and `createResearchTools(context)`.
- `AiProvider.generate(input)` accepts protected server-side messages plus JSON-schema tool declarations and returns either a final answer with candidate citations or typed tool calls; it never returns raw transport errors.
- `createResearchTools(context)` returns exactly four handlers. `context` supplies the already-authorized people, evidence, search, and graph services plus the immutable run scope.

- [ ] **Step 1: Add failing provider and tool contract tests**

Cover provider selection, canonical OpenAI/Ollama/compatible URLs, missing keys, HTTP-with-key rejection, userinfo/query/fragment rejection, private/loopback/link-local/multicast IP rejection for compatible endpoints, redirect rejection, DNS revalidation through an injected resolver, timeout/abort behavior, and redaction of an upstream error containing a key, prompt, URL, and headers. Use an injected transport and resolver; tests must not reach the public network.

Assert `Object.keys(createResearchTools(context)).sort()` equals:

```ts
["getEvidence", "getPerson", "searchGraph", "searchPeople"]
```

Assert unknown tools, mutation-like names, arbitrary URLs, foreign UUIDs, out-of-scope UUIDs, and hidden resources never invoke a handler and return a stable denied result.

- [ ] **Step 2: Verify the focused tests fail**

Run:

```bash
corepack pnpm vitest run tests/unit/ai-provider.test.ts tests/unit/ai-tools.test.ts tests/unit/env.test.ts
```

Expected: fail because the AI provider/tool modules and hardened provider URL rules do not exist.

- [ ] **Step 3: Implement the provider types and hardened transport**

Define a closed OpenAI chat-completions request/response parser with bounded message count, byte length, tool-call count, response size, timeout, and tool-loop depth. Use Node HTTP(S) with an injected DNS resolver/transport so production compatible-provider connections use the already validated address, retain correct TLS server name, and disable redirects. Map every network, timeout, protocol, size, capability, and parse failure to an internal stable provider error without retaining upstream text.

Keep provider/model disclosure separate from transport configuration:

```ts
export type AiProviderDisclosure = Readonly<{
  model: string;
  provider: "OPENAI" | "OLLAMA" | "COMPATIBLE";
}>;
```

The base URL is represented in persistence only by a domain-separated HMAC fingerprint.

- [ ] **Step 4: Implement the four authorized tools**

Each tool validates a closed input schema, intersects requested UUIDs with the immutable run scope, invokes only the current GraphQL-context domain services, caps results, and returns a bounded structured summary plus the exact resource/evidence UUIDs that may later be cited. `searchPeople` uses the existing search service with person-only kinds. `getPerson` and `getEvidence` use service reads. `searchGraph` uses the existing bounded graph-query service. Protected exact values, encrypted content, raw evidence text beyond the approved excerpt cap, and unauthorized resource identifiers never enter provider input.

- [ ] **Step 5: Pass focused tests and static checks**

Run:

```bash
corepack pnpm vitest run tests/unit/ai-provider.test.ts tests/unit/ai-tools.test.ts tests/unit/env.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai src/lib/env/server-schema.ts tests/unit/ai-provider.test.ts tests/unit/ai-tools.test.ts tests/unit/env.test.ts
git commit -m "feat: add secure AI provider boundary"
```

### Task 2: Principal-attributed persistence, durable execution, and GraphQL API

**Files:**
- Modify: `src/db/schema/ai.ts`
- Modify: `src/db/schema/operations.ts`
- Create: `drizzle/0018_task13_ai_analyst.sql`
- Create/modify: matching `drizzle/meta` snapshot and journal entry through Drizzle generation
- Create: `src/modules/ai/repository.ts`
- Create: `src/modules/ai/service.ts`
- Create: `src/modules/ai/graphql.ts`
- Modify: `src/modules/jobs/types.ts`
- Modify: `src/modules/jobs/service.ts`
- Modify: `src/worker/registry.ts`
- Create: `src/worker/handlers/ai-analysis.ts`
- Modify: `src/worker/runtime.ts`
- Modify: `src/graphql/context.ts`
- Modify: `src/graphql/loaders.ts`
- Modify: `src/graphql/schema.ts`
- Modify: `src/graphql/server.ts`
- Modify: `src/app/api/graphql/route.ts`
- Test: `tests/integration/ai-analysis.test.ts`
- Test: `tests/integration/jobs-executor.test.ts`
- Test: `tests/integration/worker-research-transactions.test.ts`
- Test: `tests/unit/job-types.test.ts`

**Interfaces:**
- Produces: `startAiAnalysis(input)`, `readAiRun(id)`, `cancelAiRun(id)`, `createAiAnalysisHandler(runtime)`, GraphQL `startAiAnalysis`, `aiRun`, and `cancelAiAnalysis`.
- `StartAiAnalysisInput` contains a bounded question, optional closed scope of person/evidence UUIDs, and a required client idempotency key. It never accepts provider/model/base URL/tool names from the caller.
- `AiRun` returns state, timestamps, provider/model disclosure, validated answer, validated citations, and redacted tool summaries; it never returns prompt content, base URL, provider request, API key, or raw error.

- [ ] **Step 1: Write failing migration, repository, worker, authorization, idempotency, and GraphQL tests**

Use live PostgreSQL fixtures and injected fake provider/Redis seams to cover:

- user and API-key principal attribution;
- cross-workspace non-disclosure;
- same principal/key/same request replay, same key/different request conflict, and different-principal independence;
- atomic creation of thread, encrypted user message, pending run, encrypted `ai_execute` job, idempotency record, and redacted audit event;
- current membership/permission and resource visibility checks at enqueue, before every tool call, and before result commit;
- revocation or grant removal after enqueue;
- valid cited completion, forged/foreign/hidden/unreturned citation rejection, and uncited-answer state;
- provider retry/dead-letter mapping without secret/prompt leakage;
- stale claim generation/lease unable to write assistant content, citations, tool calls, or final state;
- cancellation before claim and during a tool boundary;
- exactly-once final assistant message and citations across retry/replay;
- GraphQL session and API-key paths, operation budgets, stable errors, and request correlation.

- [ ] **Step 2: Verify focused tests fail**

Run with the repository's live test PostgreSQL and Redis environment:

```bash
corepack pnpm vitest run tests/unit/job-types.test.ts tests/integration/ai-analysis.test.ts tests/integration/jobs-executor.test.ts tests/integration/worker-research-transactions.test.ts --no-file-parallelism
```

Expected: fail because the AI job, repository, service, handler, and GraphQL API do not exist.

- [ ] **Step 3: Migrate actor attribution to workspace principals**

Replace AI thread/message/run user-ID attribution with workspace-principal UUID attribution, backfilling existing rows through `(workspace_id, user_id)` before enforcing composite foreign keys. Add a principal UUID attribution column for jobs while preserving/backfilling the legacy user attribution needed by existing imports/cleanup. Enforce that a job cannot carry conflicting user and principal attribution. The migration must be reversible for schema structure, fail closed on ambiguous backfills, and preserve existing rows.

Generate migration metadata with the repository command, then review the SQL rather than accepting destructive generated output.

- [ ] **Step 4: Extend the closed job union and worker registry**

Add this strict payload:

```ts
export type AiExecuteJobPayload = Readonly<{
  kind: "ai_execute";
  runId: string;
}>;
```

Update parsing, canonicalization, encryption purpose, decode guards, registry exhaustiveness, runtime construction, and unit tests. Reuse the existing PostgreSQL claim fencing, Redis lease renewal, bounded retry, dead-letter, and worker drain behavior without adding a second executor.

- [ ] **Step 5: Implement atomic service and repository operations**

Start analysis in one transaction. Normalize the question and scope; HMAC-bind request material to workspace, principal, operation, and idempotency key; create or replay an idempotency row; create one private thread when needed; encrypt the user message and job payload; store HMAC digests and provider/base-URL fingerprint; enqueue one `ai_execute` job; and write a redacted audit event.

The handler loads the current principal and authority, decrypts the input, executes a maximum of four provider turns/tool boundaries, records only allowlisted redacted tool summaries, validates citations against the run's returned-resource ledger and current visibility, then commits the assistant message/citations/final run state only while the job claim generation and lease remain current. Cancellation and finalization use compare-and-set transitions.

- [ ] **Step 6: Register GraphQL types and operations**

Add bounded Pothos inputs and outputs. Require `analysis:create` plus `analysis:run` to start, `analysis:read` to read, and `analysis:cancel` to cancel. API keys use their explicit permissions and principal ID. Return `NOT_FOUND` for foreign/invisible runs, `CONFLICT` for idempotency or terminal-state conflicts, `PROVIDER_UNAVAILABLE` only with the public message, and request IDs through the existing GraphQL error envelope.

Inject `AiRuntime` into `CreateContextInput`/server options and both production app and worker construction. Tests inject a deterministic fake provider; production constructs the provider only from validated server env.

- [ ] **Step 7: Pass focused database/GraphQL/worker tests and drift checks**

Run:

```bash
corepack pnpm vitest run tests/unit/job-types.test.ts tests/integration/ai-analysis.test.ts tests/integration/jobs-executor.test.ts tests/integration/worker-research-transactions.test.ts --no-file-parallelism
corepack pnpm db:check
corepack pnpm db:drift:check
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema drizzle src/modules/ai src/modules/jobs src/worker src/graphql src/app/api/graphql tests
git commit -m "feat: persist and execute cited AI analysis"
```

### Task 3: Generated analyst client, accessible UI, and release evidence

**Files:**
- Create: `src/graphql/operations/analyst.graphql`
- Regenerate: `src/graphql/generated/*`
- Create: `src/components/ai/analyst.tsx`
- Create: `src/components/ai/analyst-browser-adapter.tsx`
- Create: `src/app/(app)/analyst/page.tsx`
- Modify: `src/components/app-navigation.tsx`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/command-menu.tsx`
- Test: `tests/unit/analyst.test.tsx`
- Test: `tests/e2e/analyst.spec.ts`
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DESIGN.md`

**Interfaces:**
- Produces: `/analyst`, an accessible question/scope form, progress polling, cancellation, cited result rendering, redacted tool-trace summary, and provider/model disclosure.
- The browser adapter calls only generated `StartAiAnalysis`, `AiRun`, and `CancelAiAnalysis` documents through `executeBrowserGraphQL`.

- [ ] **Step 1: Add failing component and browser tests**

Cover permission-gated navigation/page access, keyboard form use, visible focus, disabled/duplicate submission, bounded question/scope validation, queued/running/completed/uncited/failed/cancelled states, abort-safe polling, workspace-switch reset, cancellation, retry guidance, provider/model disclosure, validated citation links, redacted tool summaries, mobile width, 200% zoom, reduced motion, and axe. Assert prompts, keys, base URLs, raw tool arguments, and upstream errors never appear in URL, storage, initial HTML, or rendered error output.

- [ ] **Step 2: Verify UI tests fail**

Run:

```bash
corepack pnpm vitest run tests/unit/analyst.test.tsx
NODE_OPTIONS=--conditions=react-server corepack pnpm playwright test tests/e2e/analyst.spec.ts
```

Expected: fail because the analyst operations, page, adapter, and component do not exist.

- [ ] **Step 3: Add operations and generate the typed client**

Create one fragment for the public run projection and the three start/read/cancel operations. Run:

```bash
corepack pnpm codegen
```

Review generated output and confirm no server-only field or secret-like configuration is present.

- [ ] **Step 4: Build the analyst surface**

The server page checks current viewer permissions and returns `notFound()` without `analysis:read`; starting controls require create/run permissions. The client uses a textarea, optional closed scope controls, a fresh cryptographically random idempotency key per deliberate submission, polite live progress, an explicit cancel button, and bounded exponential polling that stops on terminal state, unmount, workspace change, or abort. Render citations as first-party resource links with claim/locator text, tool calls as approved-name/count/status summaries only, and provider/model as disclosure metadata.

Add permission-gated Analyst entries to desktop/mobile navigation and the command menu.

- [ ] **Step 5: Update documentation truthfully**

Document OpenAI, compatible-provider, and opt-in Ollama configuration; explain that prompts/answers are encrypted and tool access is authorization-scoped; add the analyst workflow to the quick start; and record exact verification evidence. Mark `HUM-FR-022`, `HUM-FR-023`, and `HUM-FR-030` complete only if every verification clause in `docs/REQUIREMENTS.md` is proven by the committed tests. Leave broader jobs, whole-product, Ollama smoke, deployment, and production-readiness rows incomplete unless independently proven.

- [ ] **Step 6: Pass UI, generation, full local quality, and production build gates**

Run:

```bash
corepack pnpm vitest run tests/unit/analyst.test.tsx
NODE_OPTIONS=--conditions=react-server corepack pnpm playwright test tests/e2e/analyst.spec.ts
corepack pnpm codegen:check
corepack pnpm ci:validate
```

Expected: all pass with the configured live-test dependencies for integration portions.

- [ ] **Step 7: Commit**

```bash
git add src/graphql/operations src/graphql/generated src/components/ai src/app/'(app)'/analyst src/components/app-navigation.tsx src/components/app-shell.tsx src/components/command-menu.tsx tests README.md TODO.md docs
git commit -m "feat: add cited analyst workspace"
```

