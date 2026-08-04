# MVP Release Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current research core usable as a self-hosted alpha and MVP release candidate by enabling authorized person-overview corrections and providing a deterministic, production-valid Compose first-run path without claiming full MVP completion.

**Architecture:** Reuse the generated `UpdatePersonDocument` and existing `PersonForm`/mutation-feedback conventions; no new server API or repository path is introduced. Keep administrator secrets confined to the existing one-shot bootstrap service, correct the Docker environment contract, and add one operator command that renders, starts, bootstraps, and reports the local stack without silently enabling Ollama or weakening production validation.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS, GraphQL Yoga/Pothos generated operations, Vitest, Playwright, Docker Compose v2.

## Global Constraints

- Preserve workspace authorization and optimistic versioning; never retry a conflicted person update as an overwrite.
- Browser code must use generated GraphQL operations and must not import database repositories.
- `ADMIN_*` values remain unavailable to app, worker, migration, and seed roles.
- Production continues to require secure cookies; local HTTP is an explicit operator choice through a Docker-only development override, never an implicit production relaxation.
- The ordinary stack remains independent of Ollama; AI availability must be stated truthfully.
- Use test-first changes and keep all existing behavior passing.

---

### Task 1: Editable person overview

**Files:**
- Create: `src/components/people/person-edit-form.tsx`
- Modify: `src/components/people/person-form.tsx`
- Modify: `src/components/people/person-record-page.tsx`
- Test: `tests/unit/person-record-page.test.tsx`
- Test: `tests/e2e/research-core.spec.ts`

**Interfaces:**
- Consumes: generated `UpdatePersonDocument`, `PersonSummaryFragmentDoc`, and the existing `PersonFormInput`/`PersonFormResult` contract.
- Produces: `PersonEditForm({ person: { id, version, displayName, preferredName, sortName, biography, status, sensitivity } })` and configurable submit/cancel labels on `PersonForm`.

- [ ] **Step 1: Write failing component tests**

  Assert that a viewer without `person:update` receives no edit control, an authorized user receives an `Edit overview` button, and the editor initializes with the authorized person projection. Mock `UpdatePersonDocument` to return success and conflict payloads; assert successful refresh and preserved conflict draft with reload recovery.

- [ ] **Step 2: Run the focused test and verify failure**

  Run: `pnpm vitest run tests/unit/person-record-page.test.tsx`
  Expected: FAIL because no person overview editor exists.

- [ ] **Step 3: Implement the generated-GraphQL editor**

  Add a client wrapper which maps `PersonFormInput` to:

  ```ts
  executeBrowserGraphQL(UpdatePersonDocument, {
    input: { id: person.id, expectedVersion: person.version, ...input },
  });
  ```

  Reuse fragment/issue decoding from `PersonCreateForm`, keep drafts mounted on errors, expose a cancel action, and refresh the server page only after success or an explicit conflict reload. Render the control only when `permissions.includes("person:update")`.

- [ ] **Step 4: Add browser acceptance coverage**

  Extend the existing deterministic research journey to edit an overview, observe the updated heading/metadata, and verify narrow-viewport keyboard operation. Add a lower-privilege assertion that the control is absent.

- [ ] **Step 5: Run focused and affected tests**

  Run: `pnpm vitest run tests/unit/person-record-page.test.tsx tests/unit/person-form.test.tsx`
  Run: `NODE_OPTIONS=--conditions=react-server pnpm playwright test tests/e2e/research-core.spec.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```sh
  git add src/components/people tests/unit/person-record-page.test.tsx tests/e2e/research-core.spec.ts
  git commit -m "feat: edit person overview from profiles"
  ```

### Task 2: Deterministic Compose first run

**Files:**
- Create: `scripts/compose-first-run.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/operations/docker.md`
- Test: `tests/unit/compose-operations.test.ts`
- Test: `tests/unit/compose-config.test.ts`

**Interfaces:**
- Consumes: existing `docker compose` services and the `bootstrap-admin` profile.
- Produces: `pnpm compose:first-run`, an attended operator command that validates `.env`, starts `app` and `worker`, invokes the isolated bootstrap service, and prints the local sign-in URL plus explicit AI status.

- [ ] **Step 1: Write failing command-contract tests**

  Spawn the script with a fake Docker executable and assert ordered invocations of `compose config --quiet`, `compose up --build --detach --wait app worker`, and `compose --profile bootstrap run --rm bootstrap-admin`. Assert nonzero exit propagation, absence of secret values in output/arguments, and truthful base-stack AI-unavailable output.

- [ ] **Step 2: Run the focused test and verify failure**

  Run: `pnpm vitest run tests/unit/compose-operations.test.ts tests/unit/compose-config.test.ts`
  Expected: FAIL because the command and production-valid example contract do not exist.

- [ ] **Step 3: Implement the operator command**

  Use `spawnSync("docker", args, { stdio: "inherit" })` for each fixed argument list, refuse a missing `.env`, stop at the first nonzero status, and print only fixed status text and `NEXT_PUBLIC_APP_URL` parsed without echoing arbitrary environment content. Do not generate or move secrets and do not pass them in process arguments.

- [ ] **Step 4: Correct and document the environment/AI contract**

  Change the Compose-oriented `.env.example` to `AUTH_SECURE_COOKIES=true` and document that production-valid self-hosting requires HTTPS; operators doing loopback-only HTTP evaluation must make the explicit local-only cookie choice and cannot call it production. Explain that `compose:first-run` creates the admin but base Compose intentionally reports AI unavailable unless an external provider is configured or the Ollama overlay is started.

- [ ] **Step 5: Run focused tests and configuration rendering**

  Run: `pnpm vitest run tests/unit/compose-operations.test.ts tests/unit/compose-config.test.ts tests/unit/env.test.ts`
  Run: `docker compose config --quiet`
  Expected: PASS with a populated ignored `.env`; the test suite supplies synthetic values where appropriate.

- [ ] **Step 6: Commit**

  ```sh
  git add scripts/compose-first-run.mjs package.json .env.example README.md docs/operations/docker.md tests/unit/compose-operations.test.ts tests/unit/compose-config.test.ts
  git commit -m "feat: add deterministic compose first run"
  ```

### Task 3: MVP release evidence and backlog boundary

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `docs/REQUIREMENTS.md`
- Create: `docs/releases/SELF_HOSTED_ALPHA.md`

**Interfaces:**
- Consumes: passing Task 1/2 tests plus existing CI/Compose evidence at the release commit.
- Produces: an honest self-hosted alpha capability statement, explicit MVP-closure and production-hardening backlog, and exact verification commands without claiming full MVP completion, Vercel proof, or external-provider proof.

- [ ] **Step 1: Reconcile stale requirement wording**

  Update only rows where the audit found implementation already exists (`HUM-FR-007`, `HUM-FR-008`, `HUM-FR-024`, `HUM-FR-027`, `HUM-FR-036`). Preserve incomplete status for missing sub-capabilities, but replace misleading “implement” TODO text with the precise residual.

- [ ] **Step 2: Record the self-hosted alpha boundary**

  Define the usable alpha and MVP release candidate as the authenticated single- or multi-workspace research loop, generated GraphQL API, person/fact/evidence/relationship/file/import/search/graph/AI surfaces, and tested Docker dependencies. Preserve Vercel proof, mutable policy administration, webhooks, extraction runs, external email/provider acceptance, full performance budgets, and remaining exhaustive matrices as MVP-closure or production-hardening work according to the approved requirement contract.

- [ ] **Step 3: Run complete release gates**

  Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm db:check && pnpm db:drift:check && pnpm auth:schema:check && pnpm codegen:check && pnpm build`
  Expected: PASS.

- [ ] **Step 4: Commit**

  ```sh
  git add README.md TODO.md docs/REQUIREMENTS.md docs/releases/SELF_HOSTED_ALPHA.md
  git commit -m "docs: define the self-hosted alpha boundary"
  ```
