// @vitest-environment node

import { createHash } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { uploadSessions } from "@/db/schema/files";
import { parseServerEnv } from "@/lib/env/server-schema";
import { createStorageProxyHandlers } from "@/lib/storage/proxy";
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

async function waitForSessionLock(fixture: ResearchFixture): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ blocked }] = await fixture.connection<[{ blocked: boolean }]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%upload_sessions%'
      ) AS blocked
    `;
    if (blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected cancellation to wait for the upload-session lock");
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

  it("serializes PUT-first and cancel-first orderings on the upload session", async () => {
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
    const cancellation = cancel(putFirst.actor, putFirst.session.id);
    await waitForSessionLock(fixture);
    releasePut.resolve();
    expect((await uploading).status).toBe(204);
    expect((await cancellation).body?.errors).toBeUndefined();
    expect(client.objects.size).toBe(0);

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
});
