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

### Task 2: Principal attribution migration and AI job protocol

**Files:**
- Modify: `src/db/schema/ai.ts`
- Modify: `src/db/schema/operations.ts`
- Create: `drizzle/0018_task13_ai_analyst.sql`
- Create/modify: matching `drizzle/meta` snapshot and journal entry through Drizzle generation
- Modify: `src/modules/jobs/types.ts`
- Modify: `src/modules/jobs/service.ts`
- Modify: `src/worker/registry.ts`
- Test: `tests/integration/ai-principal-migration.test.ts`
- Test: `tests/integration/jobs-executor.test.ts`
- Test: `tests/unit/job-types.test.ts`

**Interfaces:**
- Produces: workspace-principal UUID attribution columns for AI rows/jobs, `AiExecuteJobPayload`, strict `ai_execute` payload parsing/canonicalization/encryption, and an exhaustive worker-registry slot for the Task 3 handler.
- Existing `import_execute` and `file_cleanup` job behavior remains source-compatible and migration-safe.

- [ ] **Step 1: Write failing migration and closed job-protocol tests**

Use live PostgreSQL fixtures and unit seams to cover:

- user and API-key workspace principals accepted by AI thread/message/run attribution;
- cross-workspace principal foreign keys rejected;
- existing user-attributed AI rows backfilled unambiguously;
- ambiguous or missing legacy backfills fail closed rather than dropping attribution;
- existing import/cleanup jobs preserved with legacy attribution;
- new jobs accept exactly one workspace-principal attribution and reject conflicting attribution;
- strict `ai_execute` payload parsing, canonicalization, encryption purpose, decode, and tamper rejection;
- exhaustive registry dispatch without changing current import/cleanup handlers.

- [ ] **Step 2: Verify focused tests fail**

Run with the repository's live test PostgreSQL and Redis environment:

```bash
corepack pnpm vitest run tests/unit/job-types.test.ts tests/integration/ai-principal-migration.test.ts tests/integration/jobs-executor.test.ts --no-file-parallelism
```

Expected: fail because principal-attributed AI columns and the closed AI job payload do not exist.

- [ ] **Step 3: Migrate actor attribution to workspace principals**

Replace AI thread/message/run user-ID attribution with workspace-principal UUID attribution, backfilling existing rows through `(workspace_id, user_id)` before enforcing composite foreign keys. Add a principal UUID attribution column for jobs while preserving the legacy user attribution needed by existing imports/cleanup. Enforce that a job cannot carry conflicting user and principal attribution. The migration must fail closed on ambiguous backfills and preserve existing rows.

Generate migration metadata with the repository command, then review the SQL rather than accepting destructive generated output.

- [ ] **Step 4: Extend the closed job union and worker registry**

Add this strict payload:

```ts
export type AiExecuteJobPayload = Readonly<{
  kind: "ai_execute";
  runId: string;
}>;
```

Update parsing, canonicalization, encryption purpose, decode guards, and registry exhaustiveness. Supply a typed placeholder handler only through test/runtime construction points that already require all registry handlers; Task 3 provides the real handler. Reuse the existing PostgreSQL claim fencing, Redis lease renewal, bounded retry, dead-letter, and worker drain behavior without adding a second executor.

- [ ] **Step 5: Pass migration/job tests and static gates**

Run:

```bash
corepack pnpm vitest run tests/unit/job-types.test.ts tests/integration/ai-principal-migration.test.ts tests/integration/jobs-executor.test.ts --no-file-parallelism
corepack pnpm db:check
corepack pnpm db:drift:check
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema drizzle src/modules/jobs src/worker/registry.ts tests
git commit -m "feat: add principal-attributed AI job protocol"
```

### Task 3: Atomic AI service and durable execution

**Files:**
- Create: `src/modules/ai/repository.ts`
- Create: `src/modules/ai/service.ts`
- Create: `src/worker/handlers/ai-analysis.ts`
- Modify: `src/worker/runtime.ts`
- Test: `tests/integration/ai-analysis.test.ts`
- Test: `tests/integration/worker-research-transactions.test.ts`

**Interfaces:**
- Consumes: Task 1 `AiProvider`/research tools and Task 2 principal-attributed AI/job schema plus `AiExecuteJobPayload`.
- Produces: `startAiAnalysis(input)`, `readAiRun(id)`, `cancelAiRun(id)`, and `createAiAnalysisHandler(runtime)` for Task 4's GraphQL registration.
- `StartAiAnalysisInput` contains a bounded question, optional closed scope of person/evidence UUIDs, and a required client idempotency key. It never accepts provider/model/base URL/tool names.
- `AiRun` returns state, timestamps, provider/model disclosure, validated answer, validated citations, and redacted tool summaries; it never returns prompt content, base URL, provider request, API key, or raw error.

- [ ] **Step 1: Write failing service, worker, authorization, and idempotency tests**

Use live PostgreSQL fixtures and injected fake provider/Redis seams to cover user and API-key principal attribution; cross-workspace non-disclosure; principal-bound idempotency replay/conflict/independence; atomic thread/message/run/job/idempotency/audit creation; current authority at enqueue, each tool call, and result commit; revocation/grant removal after enqueue; valid/forged/foreign/hidden/unreturned citations; provider retry/dead-letter redaction; stale claim fencing; cancellation; and exactly-once finalization.

- [ ] **Step 2: Verify focused tests fail**

```bash
corepack pnpm vitest run tests/integration/ai-analysis.test.ts tests/integration/worker-research-transactions.test.ts --no-file-parallelism
```

Expected: fail because the AI repository, service, and real handler do not exist.

- [ ] **Step 3: Implement atomic service and repository operations**

Start analysis in one transaction. Normalize the question and scope; HMAC-bind request material to workspace, principal, operation, and idempotency key; create or replay an idempotency row; create one private thread when needed; encrypt the user message and job payload; store HMAC digests and provider/base-URL fingerprint; enqueue one `ai_execute` job; and write a redacted audit event.

The handler loads current authority, decrypts input, executes at most four provider/tool boundaries, records only allowlisted redacted summaries, validates citations against the run ledger and current visibility, then commits assistant message/citations/final state only while the job claim and lease remain current. Cancellation and finalization use compare-and-set transitions.

- [ ] **Step 4: Pass focused database/worker tests and static gates**

Run:

```bash
corepack pnpm vitest run tests/integration/ai-analysis.test.ts tests/integration/worker-research-transactions.test.ts --no-file-parallelism
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai src/worker tests/integration/ai-analysis.test.ts tests/integration/worker-research-transactions.test.ts
git commit -m "feat: persist and execute cited AI analysis"
```

### Task 4: Canonical GraphQL analyst API

**Files:**
- Create: `src/modules/ai/graphql.ts`
- Modify: `src/graphql/context.ts`
- Modify: `src/graphql/loaders.ts`
- Modify: `src/graphql/schema.ts`
- Modify: `src/graphql/server.ts`
- Modify: `src/app/api/graphql/route.ts`
- Test: `tests/integration/ai-graphql.test.ts`

**Interfaces:**
- Consumes: Task 3 `startAiAnalysis`, `readAiRun`, and `cancelAiRun` service operations.
- Produces: GraphQL `startAiAnalysis`, `aiRun`, and `cancelAiAnalysis` with bounded typed inputs and public-safe projections.

- [ ] **Step 1: Write failing real-context GraphQL tests**

Cover user and API-key start/read/cancel paths; required `analysis:create`/`analysis:run`/`analysis:read`/`analysis:cancel` permissions; cross-workspace non-disclosure; principal-bound idempotency replay/conflict; operation budgets; stable expected errors; request correlation; provider/model disclosure; validated citations; redacted tool summaries; and absence of prompt, base URL, provider request, API key, or raw provider error fields from the schema and responses.

- [ ] **Step 2: Verify GraphQL tests fail**

```bash
corepack pnpm vitest run tests/integration/ai-graphql.test.ts --no-file-parallelism
```

Expected: fail because the AI Pothos registration and context wiring do not exist.

- [ ] **Step 3: Register GraphQL types and runtime injection**

Add bounded Pothos inputs/outputs. Require `analysis:create` plus `analysis:run` to start, `analysis:read` to read, and `analysis:cancel` to cancel. API keys use explicit permissions and principal ID. Return stable `NOT_FOUND`, `CONFLICT`, and `PROVIDER_UNAVAILABLE` envelopes with request correlation.

Inject `AiRuntime` into context/server options and production app construction. Tests inject a deterministic fake provider; production uses validated server env only.

- [ ] **Step 4: Pass focused GraphQL, schema-generation, and static gates**

```bash
corepack pnpm vitest run tests/integration/ai-graphql.test.ts --no-file-parallelism
corepack pnpm codegen
corepack pnpm typecheck
corepack pnpm lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai/graphql.ts src/graphql src/app/api/graphql tests/integration/ai-graphql.test.ts
git commit -m "feat: expose cited AI analysis through GraphQL"
```

### Task 5: Generated analyst client, accessible UI, and release evidence

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
