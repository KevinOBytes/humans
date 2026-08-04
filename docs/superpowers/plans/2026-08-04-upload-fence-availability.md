# Upload Fence Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve cancellation-versus-upload correctness without holding a PostgreSQL connection or transaction while object bytes stream to storage.

**Architecture:** Claim each proxy PUT with a durable, single-use upload-attempt lease in a short row-locking transaction, perform the S3-compatible PUT outside the database transaction, then reconcile the attempt in a second short transaction. Cancellation may commit during the PUT; cleanup must defer while a live attempt exists and must delete any late object after the attempt settles or its lease expires.

**Tech Stack:** Next.js, TypeScript, Drizzle ORM, PostgreSQL 18, AWS S3 client, Vitest.

## Global Constraints

- Never hold a PostgreSQL transaction, row lock, or pooled connection while awaiting the upstream object-store PUT.
- PostgreSQL remains the durable authority for upload session, attempt, cancellation, expiry, and cleanup state.
- A grant is single-use while its attempt lease is live; cancellation must remain non-blocking and must not permit a late orphan object.
- Attempt leases must be bounded to the existing 60-second proxy timeout, use database time, and recover after process termination.
- Preserve the existing 4 MiB Vercel cap and Docker purpose limits of 50 MiB, 25 MiB, and 10 MiB.
- Follow test-driven development: prove the availability/race regression fails before production changes, then make it pass.
- Do not touch unrelated product scope or the PostgreSQL service on host port 55432.

---

### Task 1: Short-transaction upload attempt fence

**Files:**
- Modify: `tests/integration/storage-proxy-lifecycle.test.ts`
- Modify: `src/db/schema/files.ts`
- Create: `drizzle/0021_upload_attempt_fence.sql`
- Create: `drizzle/meta/0021_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/modules/files/upload-proxy.ts`
- Modify: `src/modules/files/cleanup.ts`
- Modify if required: `src/modules/files/service.ts`
- Modify if required: `src/lib/storage/proxy.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: `createUploadSessionProxyExecutor({ database, deploymentMode })`, `ProxyUploadAuthorization`, `createFileCleanupService(...)`, and the existing upload-session `pending`/`cleanup_pending` lifecycle.
- Produces: a durable attempt identifier and expiry on `upload_sessions`; the proxy executor returns authorization only after the attempt is reconciled, without keeping a database connection during `upload()`.

- [x] **Step 1: Write failing integration tests for availability and race safety**

Add tests that block `LifecycleS3Client.beforePut`, begin the proxy PUT, and prove before releasing it that an unrelated database query and `cancelUploadSession` both complete. Then release the PUT and assert the request is rejected after cancellation, the late object is deleted by immediate or durable cleanup, and `cleanup_completed_at` is eventually set. Add a control test proving a non-cancelled PUT succeeds and remains eligible for `completeUpload`. Add a lease-expiry recovery test proving cleanup proceeds after a crashed attempt lease expires.

- [x] **Step 2: Run the focused test and verify RED**

Run: `TEST_DATABASE_URL=<disposable-postgres-18-url> pnpm exec vitest run tests/integration/storage-proxy-lifecycle.test.ts`

Expected: the new non-blocking cancellation/database assertions fail or time out because the current executor holds its transaction across `upload()`.

- [x] **Step 3: Add the durable attempt fence migration and schema**

Add nullable `upload_attempt_id uuid` and `upload_attempt_expires_at timestamptz(3)` columns, a paired-nullability check, and an index suitable for cleanup readiness. Generate the Drizzle snapshot and journal entry using the repository's migration tooling. Use a fresh attempt UUID and database-clock expiry no later than 60 seconds after claim.

- [x] **Step 4: Implement claim, stream, and reconcile phases**

In `createUploadSessionProxyExecutor`, claim a valid pending session in a short transaction, release it, await `upload()` outside any database callback, and reconcile by matching the attempt UUID in another short transaction. On upload failure, clear only the matching attempt. On cancellation or expiry winning, clear the matching attempt and ensure the object is deleted or cleanup remains durably queued; return false so the proxy does not report success. Reject concurrent/replayed claims while an unexpired attempt is present, and permit recovery of an expired orphaned attempt.

- [x] **Step 5: Make cleanup attempt-aware**

The cleanup worker must return retryable `cleanup_not_ready` while a matching attempt lease is live. Once the attempt is absent or expired, it may delete the object and mark cleanup complete exactly once. Reconciliation must keep cleanup/audit idempotency and database-clock semantics.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `TEST_DATABASE_URL=<disposable-postgres-18-url> pnpm exec vitest run tests/integration/storage-proxy-lifecycle.test.ts tests/integration/file-cleanup.test.ts`

Expected: all tests pass and no test expects cancellation to wait for a row lock.

- [x] **Step 7: Update architecture and requirement evidence**

Document the two-phase durable attempt fence, bounded lease recovery, and the invariant that database connections are never held during object streaming. Keep HUM-FR-017 marked complete only if the new integration evidence covers success, cancellation, late completion, and crash recovery.

- [x] **Step 8: Run the release gate**

Run the repository format, lint, typecheck, schema, unit, required PostgreSQL 18 integration, production build, Compose configuration, dependency-license, and no-cache `test:compose:lifecycle` gates. The generic parallel `pnpm test` command is not an accepted database gate because destructive suites reset shared schemas concurrently.

- [x] **Step 9: Commit**

```bash
git add docs/superpowers/plans/2026-08-04-upload-fence-availability.md tests/integration/storage-proxy-lifecycle.test.ts src/db/schema/files.ts drizzle src/modules/files/upload-proxy.ts src/modules/files/cleanup.ts src/modules/files/service.ts src/lib/storage/proxy.ts docs/ARCHITECTURE.md docs/REQUIREMENTS.md TODO.md
git commit -m "fix: release database during proxy uploads"
```
