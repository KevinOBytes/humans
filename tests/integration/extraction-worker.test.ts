// @vitest-environment node

import { Readable } from "node:stream";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { extractionRuns, files } from "@/db/schema/files";
import { s3ClientConfig, S3ObjectStore } from "@/lib/storage/s3";
import { storageObjectKey } from "@/lib/storage/proxy";
import type { ObjectStore } from "@/lib/storage/types";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createExtractionService } from "@/modules/files/extraction-service";
import { JobExecutionError } from "@/modules/jobs/types";
import { createExtractionHandler } from "@/worker/handlers/extraction";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const minioDescribe =
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_STORAGE_ENDPOINT &&
  process.env.TEST_STORAGE_ACCESS_KEY_ID &&
  process.env.TEST_STORAGE_SECRET_ACCESS_KEY
    ? describe
    : describe.skip;

class ExtractionStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  createUpload(): never {
    throw new Error("not used");
  }
  createDownload(): never {
    throw new Error("not used");
  }
  checkReachability() {
    return Promise.resolve();
  }
  getMetadata(input: { workspaceId: string; key: string }) {
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return Promise.resolve(
      body ? { bytes: body.byteLength, custom: {} } : null,
    );
  }
  openRead(input: { workspaceId: string; key: string }) {
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return Promise.resolve(
      body ? { bytes: body.byteLength, body: Readable.from([body]) } : null,
    );
  }
  exists(input: { workspaceId: string; key: string }) {
    return Promise.resolve(
      this.objects.has(`${input.workspaceId}:${input.key}`),
    );
  }
  delete() {
    return Promise.resolve();
  }
}

liveDescribe("durable extraction worker", () => {
  let fixture: ResearchFixture;
  let store: ExtractionStore;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    store = new ExtractionStore();
  });
  afterAll(async () => fixture.close());

  async function seed(input: {
    content: string;
    detectedType: string;
    extractor: string;
  }) {
    const actor = await fixture.createActor("owner");
    const fileId = newId();
    const runId = newId();
    const storageKey = `extraction/${fileId}`;
    const bytes = Buffer.from(input.content);
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey,
      originalName: "worker-input.txt",
      mediaType: input.detectedType,
      detectedType: input.detectedType,
      byteSize: bytes.byteLength,
      checksum: `sha256:${"11".repeat(32)}`,
      quarantineState: "available",
      scanState: "not_required",
      ocrState: "not_requested",
      extractionState: "pending",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(extractionRuns).values({
      id: runId,
      workspaceId: actor.workspaceId,
      fileId,
      extractor: input.extractor,
      extractorVersion: "1",
      state: "pending",
      createdBy: actor.userId,
    });
    store.objects.set(`${actor.workspaceId}:${storageKey}`, bytes);
    return { actor, fileId, runId };
  }

  it("stores bounded JSON output and completes the file lifecycle", async () => {
    const seeded = await seed({
      content: '{"name":"Ada","roles":["researcher"]}',
      detectedType: "application/json",
      extractor: "text",
    });
    const handler = createExtractionHandler({
      database: fixture.database,
      objectStore: store,
    });

    await handler(
      { extractionRunId: seeded.runId, fileId: seeded.fileId },
      {
        job: { workspaceId: seeded.actor.workspaceId },
        signal: new AbortController().signal,
      },
    );

    const [run] = await fixture.database
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    const [file] = await fixture.database
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, seeded.actor.workspaceId),
          eq(files.id, seeded.fileId),
        ),
      );
    expect(run?.state).toBe("completed");
    expect(run?.structuredOutput).toMatchObject({ json: { name: "Ada" } });
    expect(file?.extractionState).toBe("completed");
  });

  it("records malformed input as a permanent extraction error", async () => {
    const seeded = await seed({
      content: "{not-json",
      detectedType: "application/json",
      extractor: "json",
    });
    const handler = createExtractionHandler({
      database: fixture.database,
      objectStore: store,
    });

    await expect(
      handler(
        { extractionRunId: seeded.runId, fileId: seeded.fileId },
        {
          job: { workspaceId: seeded.actor.workspaceId },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "extraction_malformed_input" });

    const [run] = await fixture.database
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    expect(run?.state).toBe("error");
    expect(run?.errorSummary).toEqual({ code: "extraction_malformed_input" });
  });

  it("normalizes unknown worker codes before persisting extraction errors", async () => {
    const seeded = await seed({
      content: "not used",
      detectedType: "text/plain",
      extractor: "text",
    });
    store.openRead = async () => {
      throw new JobExecutionError(
        "provider token https://secret.example.test sk-live-secret",
        "permanent",
      );
    };
    const handler = createExtractionHandler({
      database: fixture.database,
      objectStore: store,
    });

    await expect(
      handler(
        { extractionRunId: seeded.runId, fileId: seeded.fileId },
        {
          job: { workspaceId: seeded.actor.workspaceId },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(JobExecutionError);

    const [run] = await fixture.database
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    expect(run?.errorSummary).toEqual({ code: "dependency_unavailable" });
    expect(JSON.stringify(run?.errorSummary)).not.toContain("sk-live-secret");
    expect(JSON.stringify(run?.errorSummary)).not.toContain(
      "secret.example.test",
    );
  });

  it("cancels a pending run and requeues the same run through the service", async () => {
    const seeded = await seed({
      content: "name\nAda\n",
      detectedType: "text/csv",
      extractor: "csv",
    });
    const service = createExtractionService(
      {
        actor: {
          type: "user",
          id: seeded.actor.userId,
          memberId: seeded.actor.memberId,
          principalId: seeded.actor.principalId,
          role: "owner",
          sessionId: newId(),
        },
        database: fixture.database,
        permissions: new Set(["file:update"]),
        requestId: newId(),
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        workspaceId: seeded.actor.workspaceId,
      },
      { encryptionKey: "31".repeat(32), objectStore: store },
    );

    const cancelled = await service.cancel(seeded.runId);
    expect(cancelled.state).toBe("cancelled");
    const [cancelledFile] = await fixture.database
      .select({ state: files.extractionState })
      .from(files)
      .where(eq(files.id, seeded.fileId));
    expect(cancelledFile?.state).toBe("cancelled");

    const retried = await service.retry(seeded.runId);
    expect(retried.runId).toBe(seeded.runId);
    const [pending] = await fixture.database
      .select({ state: extractionRuns.state })
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    expect(pending?.state).toBe("pending");
  });
});

minioDescribe("durable extraction worker against MinIO", () => {
  const bucket = process.env.TEST_STORAGE_BUCKET ?? "humans-private";
  const endpoint = process.env.TEST_STORAGE_ENDPOINT!;
  const client = new S3Client({
    ...s3ClientConfig({ endpoint, provider: "minio" }),
    region: process.env.TEST_STORAGE_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.TEST_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.TEST_STORAGE_SECRET_ACCESS_KEY!,
    },
  });
  const store = new S3ObjectStore(client, bucket);
  let fixture: ResearchFixture;

  beforeAll(async () => {
    fixture = new ResearchFixture();
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });
  beforeEach(() => fixture.reset());
  afterAll(async () => {
    client.destroy();
    await fixture.close();
  });

  async function seed(input: {
    content: string | Uint8Array;
    detectedType: string;
    extractor: string;
  }) {
    const actor = await fixture.createActor("owner");
    const fileId = newId();
    const runId = newId();
    const storageKey = `extraction/${fileId}`;
    const bytes = Buffer.from(input.content);
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: bucket,
      storageKey,
      originalName: "minio-worker-input.txt",
      mediaType: input.detectedType,
      detectedType: input.detectedType,
      byteSize: bytes.byteLength,
      checksum: `sha256:${"22".repeat(32)}`,
      quarantineState: "available",
      scanState: "not_required",
      ocrState: "not_requested",
      extractionState: "pending",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(extractionRuns).values({
      id: runId,
      workspaceId: actor.workspaceId,
      fileId,
      extractor: input.extractor,
      extractorVersion: "1",
      state: "pending",
      createdBy: actor.userId,
    });
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageObjectKey(actor.workspaceId, storageKey),
        Body: bytes,
        ContentType: input.detectedType,
      }),
    );
    return { actor, fileId, runId };
  }

  it("reads an object through the real S3 contract and persists structured output", async () => {
    const seeded = await seed({
      content: '{"name":"MinIO Ada"}',
      detectedType: "application/json",
      extractor: "json",
    });
    const handler = createExtractionHandler({
      database: fixture.database,
      objectStore: store,
    });

    await handler(
      { extractionRunId: seeded.runId, fileId: seeded.fileId },
      {
        job: { workspaceId: seeded.actor.workspaceId },
        signal: new AbortController().signal,
      },
    );

    const [run] = await fixture.database
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    expect(run?.state).toBe("completed");
    expect(run?.structuredOutput).toMatchObject({
      json: { name: "MinIO Ada" },
    });
  });

  it("maps the real object-store byte limit to a permanent extraction error", async () => {
    const seeded = await seed({
      content: Buffer.alloc(8 * 1024 * 1024 + 1, 65),
      detectedType: "text/plain",
      extractor: "text",
    });
    const handler = createExtractionHandler({
      database: fixture.database,
      objectStore: store,
    });

    await expect(
      handler(
        { extractionRunId: seeded.runId, fileId: seeded.fileId },
        {
          job: { workspaceId: seeded.actor.workspaceId },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "extraction_input_too_large" });
    const [run] = await fixture.database
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    expect(run?.state).toBe("error");
  });

  it("records malformed real object content without partial output", async () => {
    const seeded = await seed({
      content: "{not-json",
      detectedType: "application/json",
      extractor: "json",
    });
    const handler = createExtractionHandler({
      database: fixture.database,
      objectStore: store,
    });

    await expect(
      handler(
        { extractionRunId: seeded.runId, fileId: seeded.fileId },
        {
          job: { workspaceId: seeded.actor.workspaceId },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "extraction_malformed_input" });
    const [run] = await fixture.database
      .select()
      .from(extractionRuns)
      .where(eq(extractionRuns.id, seeded.runId));
    expect(run?.state).toBe("error");
    expect(run?.structuredOutput).toBeNull();
  });
});
