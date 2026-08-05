// @vitest-environment node

import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { extractionRuns, files } from "@/db/schema/files";
import type { ObjectStore } from "@/lib/storage/types";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createExtractionService } from "@/modules/files/extraction-service";
import { createExtractionHandler } from "@/worker/handlers/extraction";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

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
