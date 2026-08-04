// @vitest-environment node

import { createHash } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { uploadSessions } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import { parseServerEnv } from "@/lib/env/server-schema";
import type { RedisStore } from "@/lib/redis";
import {
  createStorageProxyHandlers,
  storageObjectKey,
} from "@/lib/storage/proxy";
import { createObjectStore } from "@/lib/storage/s3";
import type { ObjectStore, SignedObjectRequest } from "@/lib/storage/types";
import { createFileCleanupService } from "@/modules/files/cleanup";
import { createUploadSessionProxyExecutor } from "@/modules/files/upload-proxy";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { runJobsOnce } from "@/worker/run-once";
import { createRuntimeJobRegistry } from "@/worker/runtime";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "82".repeat(32);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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

class LifecycleS3Client {
  readonly objects = new Map<string, Uint8Array>();
  afterDelete?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;
  beforePut?: () => Promise<void>;

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    const key = String(command.input.Key);
    if (command.constructor.name === "PutObjectCommand") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of command.input
        .Body as AsyncIterable<Uint8Array>) {
        chunks.push(new Uint8Array(chunk));
      }
      await this.beforePut?.();
      this.objects.set(key, Buffer.concat(chunks));
      return {};
    }
    if (command.constructor.name === "DeleteObjectCommand") {
      await this.beforeDelete?.();
      this.objects.delete(key);
      await this.afterDelete?.();
      return {};
    }
    if (command.constructor.name === "HeadObjectCommand") {
      const object = this.objects.get(key);
      if (!object) {
        throw Object.assign(new Error("missing object"), {
          name: "NoSuchKey",
        });
      }
      return {
        ContentLength: object.byteLength,
        ContentType: "text/plain",
        Metadata: {},
      };
    }
    if (command.constructor.name === "GetObjectCommand") {
      const object = this.objects.get(key);
      if (!object) {
        throw Object.assign(new Error("missing object"), {
          name: "NoSuchKey",
        });
      }
      return {
        Body: (async function* () {
          yield object;
        })(),
        ContentLength: object.byteLength,
        ContentType: "text/plain",
      };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

function uploadRequest(grant: SignedObjectRequest, body: string): Request {
  return new Request(grant.url, {
    method: "PUT",
    headers: {
      ...grant.headers,
      "content-length": String(grant.contentLength),
    },
    body,
  });
}

liveDescribe("authoritative opaque upload fencing", () => {
  let fixture: ResearchFixture;
  let client: LifecycleS3Client;
  let objectStore: ObjectStore;

  beforeAll(() => {
    client = new LifecycleS3Client();
    objectStore = createObjectStore(
      parseServerEnv({
        NODE_ENV: "test",
        DEPLOYMENT_MODE: "docker",
        NEXT_PUBLIC_APP_URL: "https://humans.example.test",
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
        REDIS_URL: "redis://:unused@127.0.0.1:6379",
        STORAGE_PROVIDER: "minio",
        STORAGE_ENDPOINT: "http://minio.internal:9000",
        STORAGE_REGION: "us-east-1",
        STORAGE_BUCKET: "private",
        STORAGE_ACCESS_KEY_ID: "local-access",
        STORAGE_SECRET_ACCESS_KEY: "local-secret",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_BUCKET_PUBLIC: "false",
        AUTH_SECRET: "local-auth-secret-value",
        AUTH_SECURE_COOKIES: "false",
        AUTH_TRUSTED_ORIGINS: "https://humans.example.test",
        AUTH_ENCRYPTION_KEY: "81".repeat(32),
        DATA_ENCRYPTION_KEY: encryptionKey,
        PROTECTED_LOOKUP_HMAC_KEY: "83".repeat(32),
        OPERATION_LIMIT_HMAC_KEY: "84".repeat(32),
        TRUSTED_PROXY_MODE: "none",
        ADMIN_EMAIL: "admin@example.test",
        ADMIN_USERNAME: "admin",
        ADMIN_DISPLAY_NAME: "Admin",
        ADMIN_PASSWORD: "local-admin-password",
        RESEND_API_KEY: "local-resend-key",
        EMAIL_FROM: "Humans <humans@example.test>",
        AI_PROVIDER: "ollama",
        AI_BASE_URL: "http://ollama:11434/v1",
        AI_MODEL: "test-model",
      }),
      { client: client as unknown as S3Client },
    );
    fixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey,
        objectStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
  });

  beforeEach(async () => {
    await fixture.reset();
    client.objects.clear();
    client.afterDelete = undefined;
    client.beforeDelete = undefined;
    client.beforePut = undefined;
  });

  afterAll(async () => fixture.close());

  async function createPending() {
    const actor = await fixture.createActor("owner");
    const body = "safe";
    const created = await fixture.execute<{
      createUploadSession?: {
        grant: SignedObjectRequest;
        session: { id: string };
      };
    }>({
      jar: actor.jar,
      query: /* GraphQL */ `
        mutation CreateUpload($input: CreateUploadSessionInput!) {
          createUploadSession(input: $input) {
            session {
              id
            }
            grant {
              method
              url
              expiresAt
              headers
              contentLength
            }
          }
        }
      `,
      variables: {
        input: {
          originalName: "fenced.txt",
          claimedMediaType: "text/plain",
          byteSize: Buffer.byteLength(body),
          checksumSha256: createHash("sha256").update(body).digest("hex"),
          purpose: "EVIDENCE",
        },
      },
    });
    const upload = created.body?.data?.createUploadSession;
    if (!upload) throw new Error("Upload fixture was not created");
    return { actor, body, ...upload };
  }

  function handlers() {
    return createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: "private",
      secret: encryptionKey,
      executeAuthorizedUpload: createUploadSessionProxyExecutor({
        database: fixture.database,
        deploymentMode: "docker",
      }),
    });
  }

  function runCleanup(workerId: string) {
    return runJobsOnce({
      database: fixture.database,
      encryptionKey,
      random: () => 0,
      redis: new MemoryRedis(),
      registry: createRuntimeJobRegistry({
        database: fixture.database,
        encryptionKey,
        objectStore,
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        storageBucket: "private",
        storageProvider: "minio",
      }),
      workerId,
    });
  }

  async function cancel(
    actor: Awaited<ReturnType<typeof fixture.createActor>>,
    id: string,
  ) {
    return fixture.execute({
      jar: actor.jar,
      query: /* GraphQL */ `
        mutation Cancel($id: UUID!) {
          cancelUploadSession(uploadSessionId: $id) {
            session {
              id
              state
            }
          }
        }
      `,
      variables: { id },
    });
  }

  it("rejects replay of a grant after cancellation and durable cleanup", async () => {
    const pending = await createPending();
    const cancelled = await cancel(pending.actor, pending.session.id);
    expect(cancelled.body?.errors).toBeUndefined();
    await createFileCleanupService({
      database: fixture.database,
      objectStore,
      storageBucket: "private",
      storageProvider: "minio",
    }).executeFileCleanupJob({
      jobId: "019cc7c4-6ed2-7e0a-aed8-e5d451c97101",
      renewLease: async () => true,
      signal: new AbortController().signal,
      uploadSessionId: pending.session.id,
      workspaceId: pending.actor.workspaceId,
    });

    const replay = await handlers().PUT(
      uploadRequest(pending.grant, pending.body),
    );
    expect(replay.status).toBe(403);
    expect(client.objects.size).toBe(0);
    const [session] = await fixture.database
      .select({ cleanupCompletedAt: uploadSessions.cleanupCompletedAt })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(session?.cleanupCompletedAt).toBeInstanceOf(Date);
  });

  it("keeps database work and cancellation available during a PUT, then cleans the late object", async () => {
    const putFirst = await createPending();
    const putEntered = deferred();
    const releasePut = deferred();
    client.beforePut = async () => {
      putEntered.resolve();
      await releasePut.promise;
    };
    const uploading = handlers().PUT(
      uploadRequest(putFirst.grant, putFirst.body),
    );
    await putEntered.promise;
    const unrelatedQuery = fixture.connection<[{ available: number }]>`
      SELECT 1 AS available
    `;
    const cancellation = cancel(putFirst.actor, putFirst.session.id);
    const availableBeforeRelease = await Promise.race([
      Promise.all([unrelatedQuery, cancellation]).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    releasePut.resolve();
    const [uploadResponse, [databaseResult, cancelled]] = await Promise.all([
      uploading,
      Promise.all([unrelatedQuery, cancellation]),
    ]);

    expect(availableBeforeRelease).toBe(true);
    expect(databaseResult[0]?.available).toBe(1);
    expect(cancelled.body?.errors).toBeUndefined();
    expect(uploadResponse.status).toBe(403);

    await createFileCleanupService({
      database: fixture.database,
      objectStore,
      storageBucket: "private",
      storageProvider: "minio",
    }).executeFileCleanupJob({
      jobId: "019cc7c4-6ed2-7e0a-aed8-e5d451c97102",
      renewLease: async () => true,
      signal: new AbortController().signal,
      uploadSessionId: putFirst.session.id,
      workspaceId: putFirst.actor.workspaceId,
    });
    expect(client.objects.size).toBe(0);

    const [cleaned] = await fixture.database
      .select({ cleanupCompletedAt: uploadSessions.cleanupCompletedAt })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, putFirst.session.id));
    expect(cleaned?.cleanupCompletedAt).toBeInstanceOf(Date);

    client.beforePut = undefined;
    const cancelFirst = await createPending();
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    client.beforeDelete = async () => {
      deleteEntered.resolve();
      await releaseDelete.promise;
    };
    const cancelling = cancel(cancelFirst.actor, cancelFirst.session.id);
    await deleteEntered.promise;
    const rejected = await handlers().PUT(
      uploadRequest(cancelFirst.grant, cancelFirst.body),
    );
    expect(rejected.status).toBe(403);
    releaseDelete.resolve();
    expect((await cancelling).body?.errors).toBeUndefined();
    expect(client.objects.size).toBe(0);
  });

  it("keeps a non-cancelled PUT eligible for upload completion", async () => {
    const pending = await createPending();

    const uploaded = await handlers().PUT(
      uploadRequest(pending.grant, pending.body),
    );

    expect(uploaded.status).toBe(204);
    const completed = await fixture.execute({
      jar: pending.actor.jar,
      query: /* GraphQL */ `
        mutation Complete($id: UUID!) {
          completeUpload(uploadSessionId: $id) {
            session {
              id
              state
            }
            file {
              id
              availability
            }
          }
        }
      `,
      variables: { id: pending.session.id },
    });
    expect(completed.body?.errors).toBeUndefined();
    expect(completed.body?.data?.completeUpload).toMatchObject({
      session: { state: "COMPLETED" },
      file: { availability: "AVAILABLE" },
    });
    expect(client.objects.size).toBe(1);
  });

  it("recovers cleanup after a crashed upload-attempt lease expires", async () => {
    const pending = await createPending();
    const [session] = await fixture.database
      .select({ objectKey: uploadSessions.objectKey })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    if (!session) throw new Error("Upload session was not persisted");
    const attemptId = newId();
    await fixture.database
      .update(uploadSessions)
      .set({
        state: "cleanup_pending",
        failureCode: "USER_CANCELLED",
        uploadAttemptId: attemptId,
        uploadAttemptExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(uploadSessions.id, pending.session.id));
    client.objects.set(
      storageObjectKey(pending.actor.workspaceId, session.objectKey),
      Buffer.from(pending.body),
    );
    const cleanup = createFileCleanupService({
      database: fixture.database,
      objectStore,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const job = {
      jobId: "019cc7c4-6ed2-7e0a-aed8-e5d451c97103",
      renewLease: async () => true,
      signal: new AbortController().signal,
      uploadSessionId: pending.session.id,
      workspaceId: pending.actor.workspaceId,
    };

    await expect(cleanup.executeFileCleanupJob(job)).rejects.toMatchObject({
      code: "cleanup_not_ready",
      failureKind: "retryable",
    });

    await fixture.database
      .update(uploadSessions)
      .set({ uploadAttemptExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(uploadSessions.id, pending.session.id));
    await expect(cleanup.executeFileCleanupJob(job)).resolves.toEqual({
      resultReferences: [pending.session.id],
    });

    expect(client.objects.size).toBe(0);
    const [recovered] = await fixture.database
      .select({
        cleanupCompletedAt: uploadSessions.cleanupCompletedAt,
        uploadAttemptExpiresAt: uploadSessions.uploadAttemptExpiresAt,
        uploadAttemptId: uploadSessions.uploadAttemptId,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(recovered?.uploadAttemptId).toBe(attemptId);
    expect(recovered?.uploadAttemptExpiresAt?.getTime()).toBeLessThan(
      Date.now(),
    );
    expect(recovered?.cleanupCompletedAt).toBeInstanceOf(Date);
  });

  it("rearms durable cleanup when an expired blocked PUT publishes after cleanup completed", async () => {
    const pending = await createPending();
    const putEntered = deferred();
    const releasePut = deferred();
    client.beforePut = async () => {
      putEntered.resolve();
      await releasePut.promise;
    };
    const uploading = handlers().PUT(
      uploadRequest(pending.grant, pending.body),
    );
    await putEntered.promise;

    const cancelled = await cancel(pending.actor, pending.session.id);
    expect(cancelled.body?.errors).toBeUndefined();
    const [claimed] = await fixture.database
      .select({ uploadAttemptId: uploadSessions.uploadAttemptId })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(claimed?.uploadAttemptId).toEqual(expect.any(String));
    await fixture.database
      .update(uploadSessions)
      .set({
        uploadAttemptExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(
        and(
          eq(uploadSessions.id, pending.session.id),
          eq(uploadSessions.uploadAttemptId, claimed!.uploadAttemptId!),
        ),
      );

    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97104"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(client.objects.size).toBe(0);
    const [prematureCompletion] = await fixture.database
      .select({
        cleanupCompletedAt: uploadSessions.cleanupCompletedAt,
        uploadAttemptId: uploadSessions.uploadAttemptId,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(prematureCompletion?.cleanupCompletedAt).toBeInstanceOf(Date);
    expect(prematureCompletion?.uploadAttemptId).toBe(claimed?.uploadAttemptId);

    // Exercise recovery from a cleanup completion written by the prior
    // implementation, which also discarded the attempt tombstone.
    await fixture.database
      .update(uploadSessions)
      .set({ uploadAttemptExpiresAt: null, uploadAttemptId: null })
      .where(eq(uploadSessions.id, pending.session.id));

    releasePut.resolve();
    expect((await uploading).status).toBe(403);

    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97105"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(client.objects.size).toBe(0);
    const [recovered] = await fixture.database
      .select({
        cleanupCompletedAt: uploadSessions.cleanupCompletedAt,
        uploadAttemptId: uploadSessions.uploadAttemptId,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(recovered?.cleanupCompletedAt).toBeInstanceOf(Date);
    expect(recovered?.uploadAttemptId).toBeNull();

    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97106"),
    ).resolves.toMatchObject({ claimed: 0, completed: 0 });
    const cleanupJobs = await fixture.database
      .select({ id: jobs.id, state: jobs.state })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, pending.actor.workspaceId),
          eq(jobs.kind, "file_cleanup"),
        ),
      );
    expect(cleanupJobs).toHaveLength(1);
    expect(cleanupJobs[0]?.state).toBe("completed");
    const completionAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, pending.actor.workspaceId),
          eq(auditEvents.resourceId, pending.session.id),
          eq(auditEvents.action, "file.cleanup_completed"),
        ),
      );
    expect(completionAudits).toHaveLength(2);
  });

  it("retries cleanup when a late PUT reconciles after deletion but before completion", async () => {
    const pending = await createPending();
    const putEntered = deferred();
    const releasePut = deferred();
    client.beforePut = async () => {
      putEntered.resolve();
      await releasePut.promise;
    };
    const uploading = handlers().PUT(
      uploadRequest(pending.grant, pending.body),
    );
    await putEntered.promise;

    const cancelled = await cancel(pending.actor, pending.session.id);
    expect(cancelled.body?.errors).toBeUndefined();
    const [claimed] = await fixture.database
      .select({ uploadAttemptId: uploadSessions.uploadAttemptId })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(claimed?.uploadAttemptId).toEqual(expect.any(String));
    await fixture.database
      .update(uploadSessions)
      .set({
        uploadAttemptExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(
        and(
          eq(uploadSessions.id, pending.session.id),
          eq(uploadSessions.uploadAttemptId, claimed!.uploadAttemptId!),
        ),
      );

    const objectDeleted = deferred();
    const releaseCleanup = deferred();
    client.afterDelete = async () => {
      objectDeleted.resolve();
      await releaseCleanup.promise;
    };
    const cleaning = runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97107");
    await objectDeleted.promise;
    expect(client.objects.size).toBe(0);

    releasePut.resolve();
    expect((await uploading).status).toBe(403);
    expect(client.objects.size).toBe(1);
    releaseCleanup.resolve();
    await expect(cleaning).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      deferred: 1,
    });

    const [deferredSession] = await fixture.database
      .select({
        cleanupCompletedAt: uploadSessions.cleanupCompletedAt,
        uploadAttemptId: uploadSessions.uploadAttemptId,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(deferredSession).toMatchObject({
      cleanupCompletedAt: null,
      uploadAttemptId: null,
    });
    const [deferredJob] = await fixture.database
      .select({ id: jobs.id, state: jobs.state })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, pending.actor.workspaceId),
          eq(jobs.kind, "file_cleanup"),
        ),
      );
    expect(deferredJob?.state).toBe("queued");

    client.afterDelete = undefined;
    await fixture.database
      .update(jobs)
      .set({ scheduledAt: new Date(0) })
      .where(eq(jobs.id, deferredJob!.id));
    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97108"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(client.objects.size).toBe(0);

    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97109"),
    ).resolves.toMatchObject({ claimed: 0, completed: 0 });
    const [completedSession] = await fixture.database
      .select({ cleanupCompletedAt: uploadSessions.cleanupCompletedAt })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(completedSession?.cleanupCompletedAt).toBeInstanceOf(Date);
    const completionAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, pending.actor.workspaceId),
          eq(auditEvents.resourceId, pending.session.id),
          eq(auditEvents.action, "file.cleanup_completed"),
        ),
      );
    expect(completionAudits).toHaveLength(1);
  });

  it("retries cleanup when a late PUT publishes after its tombstone was removed", async () => {
    const pending = await createPending();
    const putEntered = deferred();
    const releasePut = deferred();
    client.beforePut = async () => {
      putEntered.resolve();
      await releasePut.promise;
    };
    const uploading = handlers().PUT(
      uploadRequest(pending.grant, pending.body),
    );
    await putEntered.promise;

    const cancelled = await cancel(pending.actor, pending.session.id);
    expect(cancelled.body?.errors).toBeUndefined();
    await fixture.database
      .update(uploadSessions)
      .set({ uploadAttemptExpiresAt: null, uploadAttemptId: null })
      .where(eq(uploadSessions.id, pending.session.id));
    const [beforeCleanup] = await fixture.database
      .select({
        storageMutationGeneration: uploadSessions.storageMutationGeneration,
        uploadAttemptId: uploadSessions.uploadAttemptId,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(beforeCleanup).toMatchObject({
      storageMutationGeneration: 0,
      uploadAttemptId: null,
    });

    const objectDeleted = deferred();
    const releaseCleanup = deferred();
    client.afterDelete = async () => {
      objectDeleted.resolve();
      await releaseCleanup.promise;
    };
    const cleaning = runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97110");
    await objectDeleted.promise;
    expect(client.objects.size).toBe(0);

    releasePut.resolve();
    expect((await uploading).status).toBe(403);
    expect(client.objects.size).toBe(1);
    releaseCleanup.resolve();
    await expect(cleaning).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      deferred: 1,
    });

    const [deferredSession] = await fixture.database
      .select({
        cleanupCompletedAt: uploadSessions.cleanupCompletedAt,
        storageMutationGeneration: uploadSessions.storageMutationGeneration,
      })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(deferredSession).toMatchObject({
      cleanupCompletedAt: null,
      storageMutationGeneration: 1,
    });
    const [deferredJob] = await fixture.database
      .select({ id: jobs.id, state: jobs.state })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, pending.actor.workspaceId),
          eq(jobs.kind, "file_cleanup"),
        ),
      );
    expect(deferredJob?.state).toBe("queued");

    client.afterDelete = undefined;
    await fixture.database
      .update(jobs)
      .set({ scheduledAt: new Date(0) })
      .where(eq(jobs.id, deferredJob!.id));
    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97111"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(client.objects.size).toBe(0);

    await expect(
      runCleanup("019cc7c4-6ed2-7e0a-aed8-e5d451c97112"),
    ).resolves.toMatchObject({ claimed: 0, completed: 0 });
    const [completedSession] = await fixture.database
      .select({ cleanupCompletedAt: uploadSessions.cleanupCompletedAt })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, pending.session.id));
    expect(completedSession?.cleanupCompletedAt).toBeInstanceOf(Date);
    const completionAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, pending.actor.workspaceId),
          eq(auditEvents.resourceId, pending.session.id),
          eq(auditEvents.action, "file.cleanup_completed"),
        ),
      );
    expect(completionAudits).toHaveLength(1);
  });
});
