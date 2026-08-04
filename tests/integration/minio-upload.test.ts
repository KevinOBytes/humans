// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { fileVariants } from "@/db/schema/files";
import type { RedisStore } from "@/lib/redis";
import { storageObjectKey } from "@/lib/storage/proxy";
import { S3ObjectStore, s3ClientConfig } from "@/lib/storage/s3";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createRuntimeJobRegistry } from "@/worker/runtime";
import { runJobsOnce } from "@/worker/run-once";

import { ResearchFixture } from "../support/research-fixture";

const endpoint = process.env.TEST_STORAGE_ENDPOINT;
const bucket = process.env.TEST_STORAGE_BUCKET ?? "humans-private";
const accessKeyId = process.env.TEST_STORAGE_ACCESS_KEY_ID;
const secretAccessKey = process.env.TEST_STORAGE_SECRET_ACCESS_KEY;
const liveDescribe =
  endpoint && accessKeyId && secretAccessKey ? describe : describe.skip;
const lifecycleDescribe =
  process.env.RUN_FILE_LIFECYCLE_MINIO === "true" &&
  process.env.TEST_DATABASE_URL &&
  endpoint &&
  accessKeyId &&
  secretAccessKey
    ? describe
    : describe.skip;

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

liveDescribe("real MinIO upload and download", () => {
  const client = new S3Client({
    ...s3ClientConfig({ endpoint: endpoint!, provider: "minio" }),
    region: process.env.TEST_STORAGE_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
    },
  });
  const store = new S3ObjectStore(client, bucket);

  beforeAll(async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });
  afterAll(() => client.destroy());

  it("round-trips a checksum-bound private object through signed grants", async () => {
    const workspaceId = `minio-${randomUUID()}`;
    const key = `imports/${randomUUID()}.csv`;
    const body = new TextEncoder().encode(
      "external_id,name\np-minio,MinIO Person\n",
    );
    const checksum = createHash("sha256").update(body).digest("hex");

    const upload = await store.createUpload({
      workspaceId,
      key,
      contentType: "text/csv",
      bytes: body.byteLength,
      checksumSha256: checksum,
    });
    const uploaded = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    expect(uploaded.status).toBe(200);

    await expect(store.exists({ workspaceId, key })).resolves.toBe(true);
    await expect(
      store.exists({ workspaceId: `${workspaceId}-other`, key }),
    ).resolves.toBe(false);
    const opened = await store.openRead(
      { workspaceId, key },
      { maxBytes: body.byteLength },
    );
    expect(opened?.bytes).toBe(body.byteLength);
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened?.body ?? []) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      Buffer.from(body).toString("utf8"),
    );

    const download = await store.createDownload({
      workspaceId,
      key,
      fileName: "minio-people.csv",
    });
    const downloaded = await fetch(download.url, {
      method: download.method,
      headers: download.headers,
    });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(body);

    await store.delete({ workspaceId, key });
    await expect(store.exists({ workspaceId, key })).resolves.toBe(false);
  });
});

lifecycleDescribe("real GraphQL-to-MinIO file lifecycle", () => {
  it("archives a primary object and variant while retaining a sibling sentinel", async () => {
    const encryptionKey = "73".repeat(32);
    const client = new S3Client({
      ...s3ClientConfig({ endpoint: endpoint!, provider: "minio" }),
      region: process.env.TEST_STORAGE_REGION ?? "us-east-1",
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
    const store = new S3ObjectStore(client, bucket);
    const fixture = new ResearchFixture({
      fileRuntime: {
        encryptionKey,
        objectStore: store,
        storageBucket: bucket,
        storageProvider: "minio",
      },
    });
    let sentinel: { key: string; workspaceId: string } | undefined;
    try {
      await fixture.reset();
      const owner = await fixture.createActor("owner");
      const body = new TextEncoder().encode("real lifecycle evidence");
      const checksum = createHash("sha256").update(body).digest("hex");
      const created = await fixture.execute<{
        createUploadSession?: {
          session: { id: string };
          grant: {
            method: "PUT";
            url: string;
            headers: Record<string, string>;
          };
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation CreateUpload($input: CreateUploadSessionInput!) {
            createUploadSession(input: $input) {
              session {
                id
              }
              grant {
                method
                url
                headers
              }
            }
          }
        `,
        variables: {
          input: {
            originalName: "lifecycle.txt",
            claimedMediaType: "text/plain",
            byteSize: body.byteLength,
            checksumSha256: checksum,
            purpose: "EVIDENCE",
          },
        },
      });
      expect(created.body?.errors).toBeUndefined();
      const upload = created.body?.data?.createUploadSession;
      const uploaded = await fetch(upload!.grant.url, {
        method: upload!.grant.method,
        headers: upload!.grant.headers,
        body,
      });
      expect(uploaded.ok).toBe(true);
      const completed = await fixture.execute<{
        completeUpload?: { file: { id: string; version: number } };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation Complete($id: UUID!) {
            completeUpload(uploadSessionId: $id) {
              file {
                id
                version
              }
            }
          }
        `,
        variables: { id: upload!.session.id },
      });
      expect(completed.body?.errors).toBeUndefined();
      const file = completed.body?.data?.completeUpload?.file;
      if (!file) throw new Error("Completed MinIO file is missing");
      const variantKey = `variants/${file.id}/${newId()}`;
      const sentinelKey = `variants/${file.id}/${newId()}`;
      await Promise.all([
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: storageObjectKey(owner.workspaceId, variantKey),
            Body: "delete variant",
          }),
        ),
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: storageObjectKey(owner.workspaceId, sentinelKey),
            Body: "retain sibling",
          }),
        ),
      ]);
      sentinel = { key: sentinelKey, workspaceId: owner.workspaceId };
      await fixture.database.insert(fileVariants).values({
        id: newId(),
        workspaceId: owner.workspaceId,
        parentFileId: file.id,
        kind: "thumbnail",
        storageProvider: "minio",
        storageBucket: bucket,
        storageKey: variantKey,
        mediaType: "text/plain",
        byteSize: 14,
        checksum: `sha256:${createHash("sha256").update("delete variant").digest("hex")}`,
        generatorVersion: "minio-acceptance-v1",
        createdBy: owner.userId,
      });
      const archived = await fixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation Archive($id: UUID!, $expectedVersion: Int!) {
            archiveFile(fileId: $id, expectedVersion: $expectedVersion) {
              file {
                id
                version
                archivedAt
              }
            }
          }
        `,
        variables: { id: file.id, expectedVersion: file.version },
      });
      expect(archived.body?.errors).toBeUndefined();
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
            storageBucket: bucket,
            storageProvider: "minio",
          }),
          workerId: newId(),
        }),
      ).resolves.toMatchObject({ completed: 1 });

      const primaryKey = await fixture.database.query.files.findFirst({
        where: (table, operators) => operators.eq(table.id, file.id),
        columns: { storageKey: true },
      });
      expect(primaryKey).toBeDefined();
      await expect(
        store.exists({
          workspaceId: owner.workspaceId,
          key: primaryKey!.storageKey,
        }),
      ).resolves.toBe(false);
      await expect(
        store.exists({ workspaceId: owner.workspaceId, key: variantKey }),
      ).resolves.toBe(false);
      await expect(
        store.exists({ workspaceId: owner.workspaceId, key: sentinelKey }),
      ).resolves.toBe(true);
    } finally {
      if (sentinel) {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: storageObjectKey(sentinel.workspaceId, sentinel.key),
          }),
        );
      }
      await fixture.close();
      client.destroy();
    }
  });
});
