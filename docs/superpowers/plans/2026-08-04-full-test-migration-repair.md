# Full Test and Import Migration Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a green repository-wide test command and make the legacy import recovery test prove migration into the current schema before invoking current application code.

**Architecture:** Keep database-backed suites conditionally skipped when `TEST_DATABASE_URL` is absent by deferring fixture creation into suite hooks. Preserve the targeted 0007 legacy-import assertions, then apply the ordered committed migration suffix through the current schema before testing public import recovery/retry services. Promote that self-contained temporary-database test into `test:db`.

**Tech Stack:** TypeScript, Vitest, Drizzle SQL migrations, PostgreSQL 18.

## Global Constraints

- Change test harness and release-gate coverage only; do not change production import behavior or migration SQL.
- A database-backed file must not open a connection when its conditional suite is skipped.
- Preserve the explicit negative and positive assertions around `0007_task11_review_repairs.sql`.
- Run current application services only after migrations 0008 through the repository's current highest numbered SQL migration have succeeded in lexical order.
- Discover numbered migrations from `drizzle/`; do not hard-code 0023 as a permanent upper bound.
- The migration test must continue using its own temporary database and guarded destructive-test contract.
- Use the existing real failure as RED evidence and keep all required database and release gates passing.

---

### Task 1: Make the no-database suite skip before fixture construction

**Files:**
- Modify: `tests/integration/workspace-member-administration.test.ts`

**Interfaces:**
- Consumes: `liveDescribe`, `ResearchFixture`, Vitest `beforeAll`/`beforeEach`/`afterAll`.
- Produces: a conditionally initialized `ResearchFixture` whose constructor is never called when `TEST_DATABASE_URL` is absent.

- [ ] **Step 1: Record the existing red failure**

  Run without `TEST_DATABASE_URL`:

  ```sh
  env -u TEST_DATABASE_URL -u ALLOW_TEST_DATABASE_RESET PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm vitest run tests/integration/workspace-member-administration.test.ts
  ```

  Expected: FAIL during module/suite evaluation with `TEST_DATABASE_URL is required` before Vitest can skip the suite.

- [ ] **Step 2: Defer fixture construction into the live suite hook**

  Import `beforeAll`, declare `let fixture: ResearchFixture`, assign it in `beforeAll`, retain `beforeEach(() => fixture.reset())`, and close it in `afterAll`. Do not add a fake database or weaken `ResearchFixture` validation.

- [ ] **Step 3: Verify the focused skip and database-backed behavior**

  Run the no-database command from Step 1.

  Expected: one file and all contained tests are skipped, exit zero.

  Then run against the disposable PostgreSQL test URL:

  ```sh
  TEST_DATABASE_URL=postgresql://humans:synthetic-final-suite-password@127.0.0.1:55443/humans_test ALLOW_TEST_DATABASE_RESET=true PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm vitest run tests/integration/workspace-member-administration.test.ts --no-file-parallelism
  ```

  Expected: PASS.

- [ ] **Step 4: Commit**

  ```sh
  git add tests/integration/workspace-member-administration.test.ts
  git commit -m "test: defer live workspace fixture setup"
  ```

### Task 2: Migrate legacy import fixtures through the current schema

**Files:**
- Modify: `tests/integration/import-migration-retry.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: numbered `drizzle/*.sql` migration files and the existing `applyMigrationFile` helper.
- Produces: `remainingMigrations`, an ordered list of numbered SQL migrations with numeric prefix greater than 0007, applied after focused 0007 assertions and before constructing `drizzle(upgrade, { schema })`.

- [ ] **Step 1: Record the isolated red failure**

  Run against a fresh disposable PostgreSQL database:

  ```sh
  TEST_DATABASE_URL=postgresql://humans:synthetic-final-suite-password@127.0.0.1:55443/humans_test ALLOW_TEST_DATABASE_RESET=true PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm vitest run tests/integration/import-migration-retry.test.ts --no-file-parallelism
  ```

  Expected: FAIL when current import service selection references `files.cleanup_completed_at`, because the test database stopped after migration 0007 while migration 0020 adds that column.

- [ ] **Step 2: Apply the current migration suffix before current services**

  Import `readdirSync` alongside `readFileSync`. Discover filenames matching `/^\d{4}_.+\.sql$/u`, keep prefixes numerically greater than 7, sort lexically, and map them to `drizzle/<name>`. After asserting the normalized 0007 rows and migration audit events, apply every suffix migration with the existing helper. Only then construct the Drizzle schema client and execute `prepareImport`/`retryImport` public recovery assertions.

- [ ] **Step 3: Promote the regression into required database CI**

  Add `tests/integration/import-migration-retry.test.ts` to the serial `test:db` script adjacent to the other import integration suites.

- [ ] **Step 4: Verify focused and affected behavior**

  Run:

  ```sh
  TEST_DATABASE_URL=postgresql://humans:synthetic-final-suite-password@127.0.0.1:55443/humans_test ALLOW_TEST_DATABASE_RESET=true PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm vitest run tests/integration/import-migration-retry.test.ts --no-file-parallelism
  TEST_DATABASE_URL=postgresql://humans:synthetic-final-suite-password@127.0.0.1:55443/humans_test ALLOW_TEST_DATABASE_RESET=true PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm test:db
  env -u TEST_DATABASE_URL -u ALLOW_TEST_DATABASE_RESET PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm test
  ```

  Expected: the focused migration test and required database suite pass; the repository-wide no-database command passes with database-only suites skipped.

- [ ] **Step 5: Run release gates and commit**

  Run:

  ```sh
  PATH=/Users/kevo/.nvm/versions/node/v24.19.0/bin:$PATH corepack pnpm ci:validate
  ```

  Expected: PASS.

  Commit:

  ```sh
  git add tests/integration/import-migration-retry.test.ts package.json
  git commit -m "test: carry import recovery through current migrations"
  ```
