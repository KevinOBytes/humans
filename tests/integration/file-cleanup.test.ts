// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { newId } from "@/db/id";
import { fileVariants, files, uploadSessions } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import type { RedisStore } from "@/lib/redis";
import type { ObjectStore } from "@/lib/storage/types";
import { storageObjectKey } from "@/lib/storage/proxy";
import { S3ObjectStore } from "@/lib/storage/s3";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createRuntimeJobRegistry } from "@/worker/runtime";
import { runJobsOnce } from "@/worker/run-once";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "73".repeat(32);

class MemoryRedis implements RedisStore {
  private readonly leases = new Map<string, string>();
  get() {
    return Promise.resolve(null);
  }
  set() {
    return Promise.resolve();
  }
  delete() {
    return Promise.resolve();
  }
  increment() {
    return Promise.resolve(1);
  }
  consumeTokenBucket() {
    return Promise.resolve({
      allowed: true,
      remainingMicrotokens: 1,
      retryAfterMs: 0,
    });
  }
  acquireLease(key: string, token: string) {
    if (this.leases.has(key)) return Promise.resolve(false);
    this.leases.set(key, token);
    return Promise.resolve(true);
  }
  extendLease(key: string, token: string) {
    return Promise.resolve(this.leases.get(key) === token);
  }
  releaseLease(key: string, token: string) {
    if (this.leases.get(key) !== token) return Promise.resolve(false);
    this.leases.delete(key);
    return Promise.resolve(true);
  }
}

class CleanupStore implements ObjectStore {
  readonly objects = new Set<string>();
  failDeletes = 0;
  failOnDelete: number | null = null;
  deleteCalls = 0;
  createUpload(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  createDownload(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  checkReachability() {
    return Promise.resolve();
  }
  getMetadata() {
    return Promise.resolve(null);
  }
  openRead() {
    return Promise.resolve(null);
  }
  exists(input: { workspaceId: string; key: string }) {
    return Promise.resolve(
      this.objects.has(`${input.workspaceId}:${input.key}`),
    );
  }
  delete(input: { workspaceId: string; key: string }) {
    this.deleteCalls += 1;
    if (this.failOnDelete === this.deleteCalls) {
      return Promise.reject(new Error("temporary storage outage"));
    }
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      return Promise.reject(new Error("temporary storage outage"));
    }
    this.objects.delete(`${input.workspaceId}:${input.key}`);
    return Promise.resolve();
  }
}

liveDescribe("durable file cleanup", () => {
  let fixture: ResearchFixture;
  let store: CleanupStore;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    store = new CleanupStore();
  });
  afterAll(async () => fixture.close());

  async function seedExpiredSession(
    input: {
      state?: "expired" | "rejected";
    } = {},
  ) {
    const actor = await fixture.createActor("owner");
    const id = newId();
    const objectKey = `uploads/${id}/${newId()}`;
    await fixture.database.insert(uploadSessions).values({
      id,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      intendedPurpose: "EVIDENCE",
      originalName: "legacy-cleanup.txt",
      maxBytes: 1,
      expectedChecksum: `sha256:${"11".repeat(32)}`,
      expectedMediaType: "text/plain",
      objectKey,
      state: input.state ?? "expired",
      expiresAt: new Date(Date.now() - 2 * 60 * 60_000),
      failureCode: "SESSION_EXPIRED",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    return { actor, id, objectKey };
  }

  function run(
    workerId: string,
    storage: {
      storageBucket: string;
      storageProvider: "minio" | "r2" | "s3";
    } = {
      storageBucket: "private",
      storageProvider: "minio",
    },
  ) {
    return runJobsOnce({
      database: fixture.database,
      encryptionKey,
      random: () => 0,
      redis: new MemoryRedis(),
      registry: createRuntimeJobRegistry({
        database: fixture.database,
        encryptionKey,
        objectStore: store,
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        ...storage,
      }),
      workerId,
    });
  }

  it("reconciles a legacy session and deletes only its exact object key", async () => {
    const seeded = await seedExpiredSession();
    const target = `${seeded.actor.workspaceId}:${seeded.objectKey}`;
    const sentinel = `${seeded.actor.workspaceId}:uploads/${seeded.id}/${newId()}`;
    store.objects.add(target);
    store.objects.add(sentinel);

    await expect(
      run("019cc7c4-6ed2-7e0a-aed8-e5d451c96d01"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(store.objects.has(target)).toBe(false);
    expect(store.objects.has(sentinel)).toBe(true);
    const [session] = await fixture.database
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, seeded.id));
    expect(session?.cleanupCompletedAt).toBeInstanceOf(Date);
    const [audit] = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, seeded.id),
          eq(auditEvents.action, "file.cleanup_completed"),
        ),
      );
    expect(audit).toMatchObject({
      outcome: "success",
      redactedDiff: { deleted: true },
    });
  });

  it("retries transient deletion and revives a terminal cleanup job", async () => {
    const seeded = await seedExpiredSession({ state: "rejected" });
    const target = `${seeded.actor.workspaceId}:${seeded.objectKey}`;
    store.objects.add(target);
    store.failDeletes = 1;

    await expect(
      run("019cc7c4-6ed2-7e0a-aed8-e5d451c96d02"),
    ).resolves.toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
    const [retryJob] = await fixture.database
      .select()
      .from(jobs)
      .where(eq(jobs.kind, "file_cleanup"));
    expect(retryJob).toMatchObject({ state: "queued", attemptCount: 1 });
    await fixture.database
      .update(jobs)
      .set({ state: "dead_letter", scheduledAt: new Date(0) })
      .where(eq(jobs.id, retryJob!.id));

    await expect(
      run("019cc7c4-6ed2-7e0a-aed8-e5d451c96d03"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(store.objects.has(target)).toBe(false);
    const [reconciled] = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, retryJob!.id),
          eq(auditEvents.action, "job.cleanup_reconciled"),
        ),
      );
    expect(reconciled).toBeDefined();
  });

  it("marks clean completed sessions without deleting retained evidence", async () => {
    const actor = await fixture.createActor("owner");
    const id = newId();
    const objectKey = `uploads/${id}/${newId()}`;
    const fileId = newId();
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: objectKey,
      originalName: "retained.txt",
      mediaType: "text/plain",
      detectedType: "text/plain",
      byteSize: 1,
      checksum: `sha256:${"22".repeat(32)}`,
      quarantineState: "available",
      scanState: "clean",
      ocrState: "not_requested",
      extractionState: "not_requested",
      uploadedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    await fixture.database.insert(uploadSessions).values({
      id,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      intendedPurpose: "EVIDENCE",
      originalName: "retained.txt",
      maxBytes: 1,
      expectedChecksum: `sha256:${"22".repeat(32)}`,
      expectedMediaType: "text/plain",
      objectKey,
      state: "completed",
      expiresAt: new Date(Date.now() - 2 * 60 * 60_000),
      completedAt: new Date(Date.now() - 2 * 60 * 60_000),
      fileId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    const retained = `${actor.workspaceId}:${objectKey}`;
    store.objects.add(retained);

    await expect(
      run("019cc7c4-6ed2-7e0a-aed8-e5d451c96d04"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(store.objects.has(retained)).toBe(true);
  });

  it("deletes every archived file object and safely resumes after a partial retry", async () => {
    const actor = await fixture.createActor("owner");
    const fileId = newId();
    const primaryKey = `uploads/${fileId}/${newId()}`;
    const variantKey = `variants/${fileId}/${newId()}`;
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: primaryKey,
      originalName: "archived.txt",
      byteSize: 1,
      checksum: `sha256:${"33".repeat(32)}`,
      uploadedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      deletedAt: new Date(),
      deletedBy: actor.userId,
    });
    await fixture.database.insert(fileVariants).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      parentFileId: fileId,
      kind: "thumbnail",
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: variantKey,
      checksum: `sha256:${"34".repeat(32)}`,
      createdBy: actor.userId,
    });
    store.objects.add(`${actor.workspaceId}:${primaryKey}`);
    store.objects.add(`${actor.workspaceId}:${variantKey}`);
    store.failOnDelete = 2;
    const { ensureArchivedFileCleanupJob } =
      await import("@/modules/files/cleanup");
    await ensureArchivedFileCleanupJob({
      database: fixture.database,
      encryptionKey,
      workspaceId: actor.workspaceId,
      fileId,
      createdBy: actor.userId,
    });

    await expect(run(newId())).resolves.toMatchObject({
      completed: 0,
      deferred: 1,
    });
    expect(store.objects.has(`${actor.workspaceId}:${primaryKey}`)).toBe(false);
    expect(store.objects.has(`${actor.workspaceId}:${variantKey}`)).toBe(true);
    const auditsAfterFailure = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, fileId),
          eq(auditEvents.action, "file.cleanup_completed"),
        ),
      );
    expect(auditsAfterFailure).toHaveLength(0);
    await fixture.database
      .update(jobs)
      .set({ scheduledAt: new Date(0) })
      .where(eq(jobs.kind, "file_cleanup"));
    await expect(run(newId())).resolves.toMatchObject({ completed: 1 });
    expect(store.objects.has(`${actor.workspaceId}:${primaryKey}`)).toBe(false);
    expect(store.objects.has(`${actor.workspaceId}:${variantKey}`)).toBe(false);
    const [archived] = await fixture.database
      .select({ id: files.id })
      .from(files)
      .where(eq(files.id, fileId));
    expect(archived?.id).toBe(fileId);
    const completionAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, fileId),
          eq(auditEvents.action, "file.cleanup_completed"),
        ),
      );
    expect(completionAudits).toHaveLength(1);
  });

  it("refuses an archived object whose persisted storage location differs from the runtime", async () => {
    const actor = await fixture.createActor("owner");
    const fileId = newId();
    const storageKey = `uploads/${fileId}/${newId()}`;
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "s3",
      storageBucket: "legacy-private",
      storageKey,
      originalName: "mismatch.txt",
      byteSize: 1,
      checksum: `sha256:${"35".repeat(32)}`,
      uploadedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
      deletedAt: new Date(),
      deletedBy: actor.userId,
    });
    store.objects.add(`${actor.workspaceId}:${storageKey}`);
    const { ensureArchivedFileCleanupJob } =
      await import("@/modules/files/cleanup");
    await ensureArchivedFileCleanupJob({
      database: fixture.database,
      encryptionKey,
      workspaceId: actor.workspaceId,
      fileId,
      createdBy: actor.userId,
    });

    await expect(run(newId())).resolves.toMatchObject({
      completed: 0,
      deadLettered: 1,
    });
    expect(store.objects.has(`${actor.workspaceId}:${storageKey}`)).toBe(true);
    const audits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, fileId));
    expect(audits).toHaveLength(0);
  });

  it.each([
    ["missing", null, null, null],
    ["soft-deleted", "available", "clean", new Date()],
    ["rejected", "rejected", "error", null],
    ["quarantined", "pending", "pending", null],
    ["scan-error", "available", "error", null],
  ] as const)(
    "deletes completed session objects when the file is %s",
    async (_case, quarantineState, scanState, deletedAt) => {
      const actor = await fixture.createActor("owner");
      const id = newId();
      const objectKey = `uploads/${id}/${newId()}`;
      const fileId = quarantineState && scanState ? newId() : null;
      if (fileId && quarantineState && scanState) {
        await fixture.database.insert(files).values({
          id: fileId,
          workspaceId: actor.workspaceId,
          storageProvider: "minio",
          storageBucket: "private",
          storageKey: objectKey,
          originalName: "unsafe.txt",
          mediaType: "text/plain",
          detectedType: "text/plain",
          byteSize: 1,
          checksum: `sha256:${"24".repeat(32)}`,
          quarantineState,
          scanState,
          ocrState: "not_requested",
          extractionState: "not_requested",
          uploadedBy: actor.userId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
          deletedAt,
        });
      }
      await fixture.database.insert(uploadSessions).values({
        id,
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        intendedPurpose: "EVIDENCE",
        originalName: "unsafe.txt",
        maxBytes: 1,
        expectedChecksum: `sha256:${"24".repeat(32)}`,
        expectedMediaType: "text/plain",
        objectKey,
        state: "completed",
        expiresAt: new Date(Date.now() - 2 * 60 * 60_000),
        completedAt: new Date(Date.now() - 2 * 60 * 60_000),
        fileId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      const target = `${actor.workspaceId}:${objectKey}`;
      store.objects.add(target);

      await expect(run(newId())).resolves.toMatchObject({
        claimed: 1,
        completed: 1,
      });
      expect(store.objects.has(target)).toBe(false);
      const [session] = await fixture.database
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, id));
      expect(session?.cleanupCompletedAt).toBeInstanceOf(Date);
      const [audit] = await fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, id),
            eq(auditEvents.action, "file.cleanup_completed"),
          ),
        );
      expect(audit?.redactedDiff).toMatchObject({ deleted: true });
    },
  );
});

const runMinio =
  process.env.RUN_FILE_CLEANUP_MINIO_SMOKE === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(runMinio)("durable file cleanup against MinIO", () => {
  const bucket = process.env.TEST_MINIO_BUCKET ?? "humans-task11-cleanup";
  let client: S3Client;
  let fixture: ResearchFixture;

  beforeAll(async () => {
    client = new S3Client({
      endpoint: process.env.TEST_MINIO_ENDPOINT,
      forcePathStyle: true,
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.TEST_MINIO_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TEST_MINIO_SECRET_ACCESS_KEY!,
      },
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (
        name !== "BucketAlreadyOwnedByYou" &&
        name !== "BucketAlreadyExists"
      ) {
        throw error;
      }
    }
    fixture = new ResearchFixture();
  });
  afterAll(async () => {
    await fixture.close();
    client.destroy();
  });

  it("deletes the exact expired key while retaining a sibling object", async () => {
    await fixture.reset();
    const actor = await fixture.createActor("owner");
    const sessionId = newId();
    const objectKey = `uploads/${sessionId}/${newId()}`;
    const sentinelKey = `uploads/${sessionId}/${newId()}`;
    for (const [key, body] of [
      [objectKey, "delete-me"],
      [sentinelKey, "retain-me"],
    ] as const) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageObjectKey(actor.workspaceId, key),
          Body: body,
        }),
      );
    }
    await fixture.database.insert(uploadSessions).values({
      id: sessionId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      intendedPurpose: "EVIDENCE",
      originalName: "minio-cleanup.txt",
      maxBytes: 9,
      objectKey,
      state: "expired",
      expiresAt: new Date(Date.now() - 2 * 60 * 60_000),
      failureCode: "SESSION_EXPIRED",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    const store = new S3ObjectStore(client, bucket);
    await expect(
      runJobsOnce({
        database: fixture.database,
        encryptionKey,
        random: () => 0,
        redis: new MemoryRedis(),
        registry: createRuntimeJobRegistry({
          database: fixture.database,
          encryptionKey,
          objectStore: store,
          searchIndexMaintenance: disabledSearchIndexMaintenance,
        }),
        workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96d05",
      }),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(
      await store.exists({ workspaceId: actor.workspaceId, key: objectKey }),
    ).toBe(false);
    expect(
      await store.exists({ workspaceId: actor.workspaceId, key: sentinelKey }),
    ).toBe(true);
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: storageObjectKey(actor.workspaceId, sentinelKey),
      }),
    );
  });
});
