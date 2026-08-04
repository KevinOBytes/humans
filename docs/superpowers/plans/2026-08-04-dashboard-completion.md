# Dashboard Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `HUM-FR-027` with a bounded, generated-GraphQL workspace dashboard for recent research, visible graph statistics, safe policy posture, and role-aware activity.

**Architecture:** Add domain-owned recent/statistics reads to people, graph, AI, and settings; compose them with existing imports/audit through one generated `DashboardOverview` operation. Keep visibility and ownership in domain services, use a server-rendered semantic card/list UI, and prove owner/viewer behavior through real PostgreSQL and Chromium.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS, Pothos/GraphQL Yoga, Drizzle/PostgreSQL 18, Vitest, Playwright/axe.

## Global Constraints

- Preserve the approved design in `docs/superpowers/specs/2026-08-04-dashboard-completion-design.md`.
- Use Node.js 24.x and pnpm 11.11.0.
- Browser and server components use generated GraphQL documents; they never import repositories.
- Every row and count remains workspace-scoped and applies current lifecycle, sensitivity, grant, and endpoint visibility.
- AI history is current-principal-only and never selects prompts, answers, errors, tool material, or provider credentials.
- Activity remains `audit:read`-gated; full policy posture remains owner/admin-only.
- Page sizes are fixed-bounded at 10 or less and stable ties use UUID IDs.
- Expected failures retain stable public codes/request IDs and never expose partial statistics as success.

---

### Task 1: Recent research and exact graph summary contracts

**Files:**
- Modify: `src/modules/people/repository.ts`
- Modify: `src/modules/people/service.ts`
- Modify: `src/modules/people/graphql.ts`
- Modify: `src/modules/graph/repository.ts`
- Modify: `src/modules/graph/service.ts`
- Modify: `src/modules/graph/graphql.ts`
- Modify: `src/modules/settings/repository.ts`
- Modify: `src/modules/settings/service.ts`
- Modify: `src/modules/settings/graphql.ts`
- Test: `tests/integration/dashboard-graphql.test.ts`
- Test: `tests/unit/graph-service.test.ts`

**Interfaces:**
- Produces: `people.listRecent({ first, after })`, `graph.listRecentAnalysisRuns({ first, after })`, `graph.statistics()`, and `settings.readWorkspacePolicySummary()`.
- GraphQL fields: `dashboardRecentPeople`, `dashboardRecentGraphAnalyses`, `graphStatistics`, and `workspacePolicySummary`.

- [ ] **Step 1: Add failing PostgreSQL and service tests**

  In `dashboard-graphql.test.ts`, seed tied timestamps, foreign-workspace rows, sensitivity/grant variants, relationships with hidden endpoints, analyses, and workspace settings. Assert newest-first people/graph analyses, fixed bounds, exact authorized counts, and a three-field safe policy summary available to owner and viewer. In `graph-service.test.ts`, assert statement-timeout failures do not return partial counts.

- [ ] **Step 2: Run focused tests and verify red**

  Run: `PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm vitest run tests/integration/dashboard-graphql.test.ts tests/unit/graph-service.test.ts`
  Expected: FAIL because the four fields do not exist.

- [ ] **Step 3: Implement recent people**

  Add a repository query ordered with:

  ```ts
  .orderBy(desc(people.updatedAt), desc(people.id))
  ```

  Its cursor predicate is `(updated_at, id) < (cursor.updatedAt, cursor.id)` and its `where` retains workspace, `deletedAt IS NULL`, and the service-provided `resourceVisibilitySql`. Normalize `first` to 1–10 and return the existing `PersonConnection` projection from `dashboardRecentPeople` after `person:read`.

- [ ] **Step 4: Implement recent graph analyses and exact statistics**

  Preserve the generic analysis connection and add a dashboard-specific newest-first repository/service method using `(createdAt, id)` descending plus the existing analysis authorization predicate. Implement `statistics()` inside a read-only transaction with the established short statement timeout. Count visible live people, then visible live relationships joined to source/target people; require record visibility for the relationship and both endpoints.

- [ ] **Step 5: Implement safe workspace policy summary**

  Read only:

  ```ts
  {
    defaultRetentionDays: workspaceSettings.retentionDays,
    aiEnabled: workspaceSettings.aiEnabled,
    storageEnabled: workspaceSettings.storageEnabled,
  }
  ```

  Require an active workspace and `workspace:read`; do not call or weaken `authorizeAdministrator()` and do not return access/retention policy rows.

- [ ] **Step 6: Register GraphQL types/fields and run focused tests**

  Add fixed complexity for each bounded field and stable error mapping for invalid pagination/timeout. Run the Step 2 command; expected PASS.

- [ ] **Step 7: Commit**

  ```sh
  git add src/modules/people src/modules/graph src/modules/settings tests/integration/dashboard-graphql.test.ts tests/unit/graph-service.test.ts
  git commit -m "feat: add authorized dashboard research summaries"
  ```

### Task 2: Current-principal AI analysis history

**Files:**
- Modify: `src/modules/ai/repository-domain.ts`
- Modify: `src/modules/ai/repository.ts`
- Modify: `src/modules/ai/service.ts`
- Modify: `src/modules/ai/graphql.ts`
- Test: `tests/integration/dashboard-graphql.test.ts`
- Test: `tests/unit/ai-analysis.test.ts`

**Interfaces:**
- Produces: `ai.listOwnedRuns({ first, after })` and GraphQL `dashboardRecentAiAnalyses(first, after)` using the existing safe `AiRun` type/connection.
- Consumes: current `actor.principalId`, `analysis:read`, sealed AI storage, and existing safe run mapping.

- [ ] **Step 1: Add failing ownership/redaction tests**

  Seed current-principal, same-workspace-other-principal, and foreign-workspace runs with tied timestamps. Assert only current-principal rows appear newest-first, cursor/bounds are stable, and the GraphQL selection exposes id/provider/model/state/timing without prompt, answer, error detail, tool, or citation material.

- [ ] **Step 2: Run focused tests and verify red**

  Run: `PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm vitest run tests/unit/ai-analysis.test.ts tests/integration/dashboard-graphql.test.ts`
  Expected: FAIL because owned run history is unavailable.

- [ ] **Step 3: Implement repository and service history**

  Query by both `workspaceId` and `actorPrincipalId`, order by `createdAt DESC, id DESC`, and use a versioned cursor containing exactly those two values. Cap first at 10. Reuse the public `AiRun` mapper; do not decrypt prompt or answer columns to build the history projection.

- [ ] **Step 4: Add the bounded GraphQL connection**

  Require `analysis:read`; expose the existing safe run type with only fields selected by generated operations. Apply fixed argument-sensitive complexity and existing stable validation errors.

- [ ] **Step 5: Run focused tests and commit**

  Run the Step 2 command; expected PASS.

  ```sh
  git add src/modules/ai tests/integration/dashboard-graphql.test.ts tests/unit/ai-analysis.test.ts
  git commit -m "feat: add owned AI analysis history"
  ```

### Task 3: Generated dashboard operation and semantic UI

**Files:**
- Create: `src/graphql/operations/dashboard.graphql`
- Create: `src/components/dashboard/dashboard-overview.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx`
- Create: `src/app/(app)/dashboard/loading.tsx`
- Create: `src/app/(app)/dashboard/error.tsx`
- Modify: `src/graphql/generated/*`
- Test: `tests/unit/dashboard-overview.test.tsx`
- Test: `tests/unit/app-boundaries.test.tsx`

**Interfaces:**
- Consumes: `DashboardOverviewDocument`, authenticated viewer permissions/role, and the generated fragments/connections from Tasks 1–2.
- Produces: `DashboardOverview` presentational props with normalized recent people/imports/analysis/activity/statistics/policy values.

- [ ] **Step 1: Write failing component/boundary tests**

  Assert owner/admin controls and activity, viewer absence of create/admin/audit links, explicit empty states, graph/AI merged newest-first labels, semantic sections/lists/descriptions/times, and safe text. Assert loading has one named status and error has `role="alert"`, retry, and no nested main.

- [ ] **Step 2: Run unit tests and verify red**

  Run: `PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm vitest run tests/unit/dashboard-overview.test.tsx tests/unit/app-boundaries.test.tsx`
  Expected: FAIL because the component/route boundaries do not exist.

- [ ] **Step 3: Add and generate the canonical operation**

  Implement the design document operation with `$includeActivity` controlling only `auditEvents`. Run:

  ```sh
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm codegen
  ```

  Confirm generated types contain no prompt/answer/error/tool/audit-diff/storage fields.

- [ ] **Step 4: Implement server data mapping and UI**

  Derive `includeActivity` from `permissions.includes("audit:read")`, execute once, read fragments, merge graph/AI analyses by ISO creation timestamp then ID, and render responsive semantic cards/lists. Show Manage policies only for owner/admin and Add person only for `person:create`.

- [ ] **Step 5: Implement route boundaries and run unit tests**

  Add reduced-motion-safe skeletons and generic retry error copy. Run the Step 2 command; expected PASS. Run `pnpm codegen:check`; expected clean generated drift.

- [ ] **Step 6: Commit**

  ```sh
  git add src/app/'(app)'/dashboard src/components/dashboard src/graphql/operations/dashboard.graphql src/graphql/generated tests/unit/dashboard-overview.test.tsx tests/unit/app-boundaries.test.tsx
  git commit -m "feat: build the workspace research dashboard"
  ```

### Task 4: Owner/viewer acceptance and requirement closeout

**Files:**
- Create: `tests/e2e/dashboard.spec.ts`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`
- Modify: `docs/releases/SELF_HOSTED_ALPHA.md`

**Interfaces:**
- Consumes: completed Tasks 1–3 and existing deterministic research fixture/member helpers.
- Produces: executable owner/viewer acceptance evidence and exact `HUM-FR-027` traceability closeout.

- [ ] **Step 1: Add the browser acceptance journey**

  Seed populated and empty workspaces plus a viewer. Assert owner/viewer panel differences, newest-first research, merged graph/AI analysis labels, exact visible counts, safe policy summary, explicit empty states, keyboard focus, zero horizontal overflow at 390x844 and 320 CSS pixels, RTL, reduced motion, axe zero, and absence of restricted identifiers/prompts/credentials/storage/audit-diff material in URL/storage/HTML/RSC/console.

- [ ] **Step 2: Run PostgreSQL and browser evidence**

  Run:

  ```sh
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm vitest run tests/integration/dashboard-graphql.test.ts --no-file-parallelism
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH NODE_OPTIONS=--conditions=react-server pnpm playwright test tests/e2e/dashboard.spec.ts
  ```

  Expected: PASS for owner, viewer, empty, responsive, RTL, zoom, and accessibility cases.

- [ ] **Step 3: Close exactly HUM-FR-027**

  Update its requirement verification with exact current test evidence, change status to Complete, remove only the matching TODO entry, and update the alpha release capability list. Recount incomplete requirement/TODO IDs and require exact one-to-one equality.

- [ ] **Step 4: Run complete release gates**

  Run:

  ```sh
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm ci:validate
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH pnpm test:db
  ```

  Expected: all format, lint, type, unit, schema, migration, generated, dependency, production build, and real PostgreSQL tests pass.

- [ ] **Step 5: Commit**

  ```sh
  git add tests/e2e/dashboard.spec.ts docs/REQUIREMENTS.md TODO.md docs/releases/SELF_HOSTED_ALPHA.md
  git commit -m "test: prove the role-aware dashboard"
  ```
