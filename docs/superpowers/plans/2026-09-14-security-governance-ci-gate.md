# Security Governance CI Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the required PostgreSQL integration gate execute the repository's dedicated authentication, API-key, governance, case, and break-glass suites and prevent accidental omission of those suites in future changes.

**Architecture:** Keep the existing serial disposable PostgreSQL/Redis/MinIO job and add a small explicit security/governance integration command. A unit contract will parse the command and workflow, asserting that every required suite is named. No authorization or runtime behavior changes are part of this tranche.

**Tech Stack:** pnpm 11.11.0, Node 24, Vitest, GitHub Actions, TypeScript.

**Spec:** `.superpowers/sdd/2026-09-14-full-mvp-closeout/security-governance-audit.md` (SG-01).

## Global Constraints

- Use the Node.js 24 and pnpm versions declared in `package.json`.
- Keep the database command serial with `--no-file-parallelism`.
- Do not weaken, skip, or rewrite security assertions to make the gate pass.
- Do not add secrets, populated environment files, or private operator state.
- Update `docs/REQUIREMENTS.md` and `TODO.md` together only after evidence exists.

### Task 1: Required security/governance integration command

**Files:**
- Modify: `package.json` scripts section.
- Modify: `.github/workflows/ci.yml` database-integration job.
- Create: `tests/unit/security-governance-ci-contract.test.ts`.
- Modify: `tests/unit/ci-workflow-contract.test.ts` only if the existing contract helper is the established place for workflow assertions.
- Test: the new contract and every named integration suite through the existing `test:db` environment.

**Interfaces:**
- Produces a package script named `test:db:security` that invokes Vitest with the exact required integration files and `--no-file-parallelism`.
- The workflow's database job invokes `pnpm test:db:security` after the existing `pnpm test:db` command.
- The contract test reads `package.json` and `.github/workflows/ci.yml` as text/JSON and fails if any required suite name is absent from the script and workflow invocation.

- [ ] **Step 1: Write the failing omission contract.**

  Add a Vitest test that defines this exact required set:

  ```ts
  const requiredSuites = [
    "tests/integration/auth-security.test.ts",
    "tests/integration/api-key-lifecycle.test.ts",
    "tests/integration/workspace-member-administration.test.ts",
    "tests/integration/governance-lifecycle.test.ts",
    "tests/integration/governance-api.test.ts",
    "tests/integration/cases-api.test.ts",
    "tests/integration/graphql-case-idempotency.test.ts",
    "tests/integration/break-glass-access.test.ts",
  ];
  ```

  Assert that `package.json` contains a `test:db:security` script containing every suite and `--no-file-parallelism`, and that `.github/workflows/ci.yml` invokes `pnpm test:db:security` in the `database-integration` job. Before the script exists, the test must fail with a missing-script assertion.

- [ ] **Step 2: Run the contract to verify it fails.**

  Run:

  ```sh
  pnpm exec vitest run tests/unit/security-governance-ci-contract.test.ts --no-file-parallelism
  ```

  Expected result: one failing test because the `test:db:security` script is absent.

- [ ] **Step 3: Add the explicit command and workflow invocation.**

  Add `test:db:security` to `package.json` with the eight exact suite paths from Step 1 and `--no-file-parallelism`. Add a named workflow step immediately after the existing database integration command:

  ```yaml
  - name: Run required security and governance integration seam
    timeout-minutes: 15
    run: corepack pnpm test:db:security
  ```

  Keep the existing AI-retention selector unchanged. Do not merge the new suites into unit tests or rely on transitive imports.

- [ ] **Step 4: Run the focused contract and the security command.**

  Run:

  ```sh
  pnpm exec vitest run tests/unit/security-governance-ci-contract.test.ts --no-file-parallelism
  TEST_DATABASE_URL=... pnpm test:db:security
  ```

  The contract must pass. If the database URL is unavailable locally, record that only the contract ran locally and rely on the disposable database CI job for the integration result; do not mark the integration suites complete from a skipped run.

- [ ] **Step 5: Run quality gates.**

  Run:

  ```sh
  pnpm format:check
  pnpm lint
  pnpm typecheck
  pnpm exec vitest run tests/unit/security-governance-ci-contract.test.ts --no-file-parallelism
  pnpm build
  git diff --check
  ```

- [ ] **Step 6: Update evidence and commit.**

  After the GitHub database job passes, update `docs/REQUIREMENTS.md` and `TODO.md` with the exact run URL and suite result. Commit the implementation and evidence together:

  ```sh
  git add package.json .github/workflows/ci.yml tests/unit/security-governance-ci-contract.test.ts docs/REQUIREMENTS.md TODO.md
  git commit -m "test: require security governance integration gate"
  ```

