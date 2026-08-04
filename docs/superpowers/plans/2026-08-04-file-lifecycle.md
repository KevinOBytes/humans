# File Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the usable MVP lifecycle for private files, stored variants, and owned upload sessions, including durable deletion from S3-compatible storage.

**Architecture:** Keep PostgreSQL authoritative. User mutations lock and update workspace-scoped rows inside the existing live-authority research transaction, while object deletion runs through the existing encrypted durable `file_cleanup` job and remains idempotent across partial storage failures. GraphQL exposes only controlled metadata and signed grants; the evidence page adds recovery and archive controls without exposing object keys.

**Tech Stack:** TypeScript, Next.js 16, GraphQL Yoga/Pothos, Drizzle ORM, PostgreSQL, S3-compatible object storage (R2/S3/MinIO), Vitest, Playwright, React, Tailwind CSS.

## Global Constraints

- PostgreSQL remains authoritative; Redis is not a source of file lifecycle state.
- Server-generated object keys are never accepted from or exposed to GraphQL clients.
- Every lookup and mutation is workspace scoped and preserves resource sensitivity/grant visibility.
- Upload-session regrant and cancellation are limited to the session user who created the session; cross-workspace and same-workspace non-owner requests return `NOT_FOUND`.
- File archival requires `file:delete`, an exact positive `expectedVersion`, and current resource access; API-key actors with live `file:delete` authority may archive files.
- Archive commits soft deletion and durable cleanup intent atomically before any best-effort object-store call.
- Cleanup deletes only database-recorded keys for the archived file and its variants, is safe to retry after any partial deletion, and never deletes an active clean file.
- Completed imports and evidence records retain their database provenance when an underlying file is archived.
- New behavior follows test-driven development: the covering test must fail for the expected missing behavior before production code is written.
- Generated GraphQL artifacts and Drizzle migration metadata must be committed and drift-clean.
- Requirement documentation may mark `HUM-FR-017` Complete only after real PostgreSQL, GraphQL, and MinIO lifecycle evidence passes in the current tree.

---

### Task 1: Durable file archival and complete object cleanup

**Files:**
- Modify: `src/db/schema/files.ts`
- Modify: `src/modules/files/repository.ts`
- Modify: `src/modules/files/service.ts`
- Modify: `src/modules/files/cleanup.ts`
- Modify: `src/modules/jobs/types.ts`
- Modify: `src/worker/handlers/storage-cleanup.ts`
- Modify: `src/worker/runtime.ts`
- Create: `drizzle/0019_file_lifecycle.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0019_snapshot.json`
- Test: `tests/integration/files-api.test.ts`
- Test: `tests/integration/file-cleanup.test.ts`
- Test: `tests/unit/job-payload.test.ts`
- Test: `tests/unit/job-types.test.ts`

**Interfaces:**
- Produces: `FilesService.archiveFile(fileId: string, expectedVersion: number)` returning `{ file, issues }`.
- Produces: `FileCleanupJobPayload` as the strict union `{ kind: "file_cleanup"; uploadSessionId: string } | { kind: "file_cleanup"; fileId: string }` with exactly one target key.
- Produces: `ensureArchivedFileCleanupJob({ database, encryptionKey, workspaceId, fileId, createdBy })` scheduled immediately with a purpose-separated v1 HMAC idempotency key.
- Produces: repository methods that lock/archive a visible file, enumerate its variant object keys, and locate its completed upload session without accepting storage identifiers from callers.

- [ ] **Step 1: Write failing PostgreSQL service tests**

Add tests that exercise real services and rows:

```ts
it("archives an authorized file with optimistic versioning and enqueues durable cleanup", async () => {
  const completed = await uploadEvidence(actor);
  const result = await files.archiveFile(completed.file.id, completed.file.version);
  expect(result.file).toMatchObject({ id: completed.file.id, deletedAt: expect.any(Date), version: completed.file.version + 1 });
  await expect(files.get(completed.file.id)).resolves.toBeNull();
  expect(await queuedCleanupForFile(completed.file.id)).toMatchObject({ kind: "file_cleanup", state: "queued" });
});

it("does not archive on a stale version or through another workspace", async () => {
  await expect(files.archiveFile(file.id, file.version + 1)).rejects.toHaveGraphQLCode("CONFLICT");
  await expect(otherWorkspaceFiles.archiveFile(file.id, file.version)).rejects.toHaveGraphQLCode("NOT_FOUND");
});
```

Add strict payload tests proving a cleanup payload accepts exactly one of `fileId` or `uploadSessionId` and rejects unknown keys, both targets, missing targets, or invalid UUIDs.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/integration/files-api.test.ts tests/integration/file-cleanup.test.ts tests/unit/job-payload.test.ts tests/unit/job-types.test.ts --no-file-parallelism`

Expected: FAIL because `archiveFile`, file-target cleanup payloads, and durable archived-file cleanup do not exist.

- [ ] **Step 3: Add schema constraints and the durable archive transaction**

Add state checks for file quarantine/scan/OCR/extraction values, upload-session lifecycle values, and consistent session completion/failure columns. Add a workspace/provider/bucket/key uniqueness constraint for variants. Generate migration `0019_file_lifecycle.sql` and its snapshot.

Implement archive as one live-authority write transaction:

```ts
const archived = await repository.archiveFile({
  id: fileId,
  workspaceId: context.workspaceId,
  expectedVersion,
  deletedAt: now,
  deletedBy: context.actor.id,
});
await ensureArchivedFileCleanupJob({ database, encryptionKey, workspaceId: context.workspaceId, fileId, createdBy });
await audit.write(database, { action: "file.archived", resourceKind: "file", resourceId: fileId, changedFields: ["deletedAt"] });
```

The repository must distinguish an inaccessible/missing file (`NOT_FOUND`) from an accessible live row with a stale version (`CONFLICT`) without leaking another workspace.

- [ ] **Step 4: Make cleanup exact, variant-aware, and retry-safe**

For a file-target cleanup job, lock the archived file, load the primary key and all variant keys from PostgreSQL, renew the lease, and delete each exact key. Treat an already-missing object as success through the object-store adapter contract. Do not remove database rows; record `file.cleanup_completed` only after every primary/variant deletion succeeds. A retry after deleting only a prefix of the keys must finish successfully. The existing upload-session target behavior must remain unchanged.

- [ ] **Step 5: Verify GREEN and migration drift**

Run: `pnpm vitest run tests/integration/files-api.test.ts tests/integration/file-cleanup.test.ts tests/unit/job-payload.test.ts tests/unit/job-types.test.ts --no-file-parallelism`

Run: `pnpm db:check && pnpm db:drift:check`

Expected: all focused tests pass and generated migration metadata is drift-clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/files.ts src/modules/files src/modules/jobs/types.ts src/worker drizzle tests/integration/files-api.test.ts tests/integration/file-cleanup.test.ts tests/unit/job-payload.test.ts tests/unit/job-types.test.ts
git commit -m "feat: add durable file archival"
```

### Task 2: Upload recovery, GraphQL operations, and usable evidence controls

**Files:**
- Modify: `src/modules/files/repository.ts`
- Modify: `src/modules/files/service.ts`
- Modify: `src/modules/files/graphql.ts`
- Modify: `src/graphql/operations/files-imports.graphql`
- Modify: `src/components/files/upload-panel.tsx`
- Create: `src/components/files/file-lifecycle-controls.tsx`
- Modify: `src/app/(app)/evidence/page.tsx`
- Modify: `tests/integration/files-api.test.ts`
- Modify: `tests/integration/file-cleanup.test.ts`
- Modify: `tests/integration/minio-upload.test.ts`
- Modify: `tests/unit/upload-panel.test.tsx`
- Create: `tests/unit/file-lifecycle-controls.test.tsx`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DESIGN.md`
- Modify: `docs/REQUIREMENTS.md`
- Modify: `TODO.md`

**Interfaces:**
- Produces: `FilesService.listUploadSessions({ first, after, states })`, owner-scoped and cursor paginated.
- Produces: `FilesService.regrantUploadSession(uploadSessionId)` returning `{ session, grant, issues }` only while pending and unexpired.
- Produces: `FilesService.cancelUploadSession(uploadSessionId)` returning `{ session, issues }`, atomically changing pending to `cleanup_pending` and scheduling immediate durable cleanup.
- Produces: GraphQL `uploadSessions`, `regrantUploadSession`, `cancelUploadSession`, `archiveFile`, and `File.variants` without storage provider/bucket/key exposure.
- Produces: generated browser operations `PendingWorkspaceUploads`, `RegrantWorkspaceUpload`, `CancelWorkspaceUpload`, and `ArchiveWorkspaceFile`.

- [ ] **Step 1: Write failing GraphQL and component tests**

Add real-context GraphQL tests proving:

```graphql
query PendingWorkspaceUploads { uploadSessions(first: 20, states: [PENDING]) { nodes { id originalName byteSize state expiresAt } } }
mutation RegrantWorkspaceUpload($id: UUID!) { regrantUploadSession(uploadSessionId: $id) { session { id state } grant { method url headers contentLength } } }
mutation CancelWorkspaceUpload($id: UUID!) { cancelUploadSession(uploadSessionId: $id) { session { id state } } }
mutation ArchiveWorkspaceFile($id: UUID!, $expectedVersion: Int!) { archiveFile(fileId: $id, expectedVersion: $expectedVersion) { file { id version archivedAt } } }
```

Cover owner success, same-workspace non-owner `NOT_FOUND`, cross-workspace `NOT_FOUND`, expired/rejected/completed regrant conflicts, cancel-versus-complete serialization, live permission loss, archived-file download denial, variant metadata visibility, and API-key file archival with `file:delete` versus denial without it.

Write component tests proving a user can cancel an abandoned upload and confirm archive; controls expose status through an assistive-technology alert, preserve visible focus, and never render object keys or provider errors.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/integration/files-api.test.ts tests/unit/upload-panel.test.tsx tests/unit/file-lifecycle-controls.test.tsx --no-file-parallelism`

Expected: FAIL because the recovery/archive GraphQL operations and controls do not exist.

- [ ] **Step 3: Implement owner-scoped recovery and typed GraphQL**

List only the current user actor's sessions. Regrant must lock/revalidate a pending, unexpired session before signing the existing controlled key; cancellation must lock the session, transition only `pending` to `cleanup_pending`, clear `cleanupCompletedAt`, enqueue immediate cleanup, write a redacted audit event, and then attempt best-effort deletion. Do not allow regrant/cancel through API keys because upload-session ownership is user-bound.

Expose variants as safe metadata (`id`, `kind`, `mediaType`, `byteSize`, `checksum`, `generatorVersion`, `createdAt`) and never expose storage coordinates. Generate the checked-in operations; prime the archived file result in the mutation resolver and resolve variants through a workspace-scoped service method.

- [ ] **Step 4: Add evidence-page recovery and archive controls**

Render pending owned sessions above the file table with their name, size, expiry, and Cancel action. Regrant is used internally when a user reselects the exact local file: verify name, byte length, and SHA-256 in the browser before PUT; refuse mismatch without issuing completion. Add an archive confirmation per visible file using its exact version and refresh the route after success. Keep downloads available only for clean/available files.

- [ ] **Step 5: Add real MinIO lifecycle acceptance and required CI coverage**

Extend the MinIO integration to upload a primary object plus seeded variant, archive through the real GraphQL context, execute the durable worker, and assert both exact keys are absent while a sibling sentinel remains. Add `files-api.test.ts` and `file-cleanup.test.ts` to `test:db`; keep the opt-in real MinIO case in the Compose lifecycle job so required CI proves GraphQL-to-MinIO archival.

- [ ] **Step 6: Update requirement evidence honestly**

Document upload creation/completion/regrant/cancel, variant metadata, archive semantics, and durable deletion. Mark `HUM-FR-017` Complete and check its single `TODO.md` entry only if all PostgreSQL, GraphQL, browser/unit, required CI, and real MinIO lifecycle checks pass. Do not change unrelated incomplete requirements.

- [ ] **Step 7: Verify the slice**

Run: `pnpm codegen:check`

Run: `pnpm test:unit`

Run: `pnpm test:db`

Run: `pnpm test:compose:lifecycle`

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build`

Expected: all checks pass with Node 24 and pnpm 11.11.0.

- [ ] **Step 8: Commit**

```bash
git add src/modules/files src/graphql src/components/files src/app/'(app)'/evidence tests package.json README.md docs TODO.md
git commit -m "feat: complete private file lifecycle"
```
