// @vitest-environment node

import { createHash } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { uploadSessions } from "@/db/schema/files";
import { parseServerEnv } from "@/lib/env/server-schema";
import {
  createStorageProxyHandlers,
  storageObjectKey,
} from "@/lib/storage/proxy";
import { createObjectStore } from "@/lib/storage/s3";
import type { ObjectStore, SignedObjectRequest } from "@/lib/storage/types";
import { createFileCleanupService } from "@/modules/files/cleanup";
import { createUploadSessionProxyExecutor } from "@/modules/files/upload-proxy";

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

class LifecycleS3Client {
  readonly objects = new Map<string, Uint8Array>();
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
    expect(recovered).toMatchObject({
      uploadAttemptExpiresAt: null,
      uploadAttemptId: null,
    });
    expect(recovered?.cleanupCompletedAt).toBeInstanceOf(Date);
  });
});
