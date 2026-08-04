// @vitest-environment node

import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { members, sessions } from "@/db/schema/auth";
import {
  files as filesTable,
  importRows,
  imports as importsTable,
} from "@/db/schema/files";
import { jobs } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { relationshipTypes } from "@/db/schema/relationships";
import {
  accessPolicies,
  resourceGrants,
  workspaces,
} from "@/db/schema/workspaces";
import type { RedisStore } from "@/lib/redis";
import type { ObjectStore } from "@/lib/storage/types";
import { createFilesService } from "@/modules/files/service";
import { createImportsService } from "@/modules/imports/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createJobsService } from "@/modules/jobs/service";
import {
  createImportExecuteHandler,
  createImportExecuteService,
} from "@/worker/handlers/import";
import { createJobRegistry } from "@/worker/registry";
import { runJobsOnce } from "@/worker/run-once";

import { ResearchFixture } from "../support/research-fixture";
import { createTestConnection, createTestDatabase } from "../support/auth";
import type { SessionActor } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "31".repeat(32);
const IMPORT_PREPARE_GATE = 8_104_202_609;

function importJobIdempotencyHash(input: {
  actorId: string;
  key: string;
  workspaceId: string;
}): string {
  const canonical = `{"actorId":${JSON.stringify(input.actorId)},"key":${JSON.stringify(input.key)},"workspaceId":${JSON.stringify(input.workspaceId)}}`;
  return createHmac("sha256", Buffer.from(encryptionKey, "hex"))
    .update("humans:import-job-idempotency:v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

function importJobRequestHash(input: {
  actorId: string;
  expectedVersion: number;
  fileChecksum: string;
  fileId: string;
  fileSize: number;
  importId: string;
  mappingHash: string;
  mappingId: string;
  mappingVersion: number;
  mode: "COMMIT" | "DRY_RUN";
  operation: "start" | "retry";
  workspaceId: string;
}): string {
  const canonical = `{"actorId":${JSON.stringify(input.actorId)},"expectedVersion":${input.expectedVersion},"fileChecksum":${JSON.stringify(input.fileChecksum)},"fileId":${JSON.stringify(input.fileId)},"fileSize":${input.fileSize},"importId":${JSON.stringify(input.importId)},"mappingHash":${JSON.stringify(input.mappingHash)},"mappingId":${JSON.stringify(input.mappingId)},"mappingVersion":${input.mappingVersion},"mode":${JSON.stringify(input.mode)},"operation":${JSON.stringify(input.operation)},"workspaceId":${JSON.stringify(input.workspaceId)}}`;
  return `sha256:${createHmac("sha256", Buffer.from(encryptionKey, "hex"))
    .update("humans:import-job-request:v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex")}`;
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForActivity(
  fixture: ResearchFixture,
  applicationName: string,
  expectedWaitEventType: "AdvisoryLock" | "Lock",
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [activity] = await fixture.connection<
      [{ waitEvent: string | null; waitEventType: string | null }]
    >`
      SELECT wait_event AS "waitEvent", wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
    `;
    if (
      expectedWaitEventType === "AdvisoryLock"
        ? activity?.waitEvent === "advisory"
        : activity?.waitEventType === "Lock"
    ) {
      return;
    }
    await delay(10);
  }
  throw new Error(
    `Timed out waiting for ${applicationName} ${expectedWaitEventType}`,
  );
}

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  openReadDelayMs = 0;
  openReadCalls = 0;
  async createUpload(input: {
    workspaceId: string;
    key: string;
    bytes: number;
    contentType: string;
    checksumSha256: string;
  }) {
    return {
      method: "PUT" as const,
      url: "https://storage.example/upload",
      expiresAt: new Date(Date.now() + 300_000),
      contentLength: input.bytes,
      headers: {},
    };
  }
  async createDownload() {
    return {
      method: "GET" as const,
      url: "https://storage.example/download",
      expiresAt: new Date(Date.now() + 120_000),
      headers: {},
    };
  }
  async checkReachability() {}
  async getMetadata(input: { workspaceId: string; key: string }) {
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body ? { bytes: body.byteLength, custom: {} } : null;
  }
  async openRead(input: { workspaceId: string; key: string }) {
    this.openReadCalls += 1;
    if (this.openReadDelayMs > 0) await delay(this.openReadDelayMs);
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body
      ? { bytes: body.byteLength, body: Readable.from([body]) }
      : null;
  }
  async exists(input: { workspaceId: string; key: string }) {
    return this.objects.has(`${input.workspaceId}:${input.key}`);
  }
  async delete(input: { workspaceId: string; key: string }) {
    this.objects.delete(`${input.workspaceId}:${input.key}`);
  }
}

class MemoryRedis implements RedisStore {
  private readonly leases = new Map<string, string>();

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  increment(): Promise<number> {
    return Promise.resolve(1);
  }
  acquireLease(key: string, token: string): Promise<boolean> {
    if (this.leases.has(key)) return Promise.resolve(false);
    this.leases.set(key, token);
    return Promise.resolve(true);
  }
  extendLease(key: string, token: string): Promise<boolean> {
    return Promise.resolve(this.leases.get(key) === token);
  }
  releaseLease(key: string, token: string): Promise<boolean> {
    if (this.leases.get(key) !== token) return Promise.resolve(false);
    this.leases.delete(key);
    return Promise.resolve(true);
  }
  consumeTokenBucket(): Promise<{
    allowed: boolean;
    remainingMicrotokens: number;
    retryAfterMs: number;
  }> {
    return Promise.resolve({
      allowed: true,
      remainingMicrotokens: 0,
      retryAfterMs: 0,
    });
  }
}

async function runImportWorker(fixture: ResearchFixture, workerId: string) {
  return runJobsOnce({
    database: fixture.database,
    encryptionKey,
    redis: new MemoryRedis(),
    registry: createJobRegistry({
      aiExecute: async () => undefined,
      importExecute: createImportExecuteHandler(
        createImportExecuteService({
          database: fixture.database,
          encryptionKey,
          searchIndexMaintenance: disabledSearchIndexMaintenance,
        }),
      ),
      fileCleanup: async () => undefined,
    }),
    workerId,
  });
}

async function serviceContext(fixture: ResearchFixture, actor: SessionActor) {
  const [[session], [member]] = await Promise.all([
    fixture.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, actor.userId))
      .limit(1),
    fixture.database
      .select({ role: members.role })
      .from(members)
      .where(eq(members.id, actor.memberId))
      .limit(1),
  ]);
  if (!session || !member) throw new Error("fixture membership is missing");
  return {
    actor: {
      type: "user" as const,
      id: actor.userId,
      memberId: actor.memberId,
      principalId: actor.principalId,
      role: member.role,
      sessionId: session.id,
    },
    database: fixture.database,
    operationLimiter: {
      consume: async () => ({
        allowed: true,
        remainingMicrotokens: 1,
        retryAfterMs: 0,
      }),
    },
    permissions: new Set([
      "file:create",
      "file:read",
      "import:create",
      "import:update",
      "import:read",
      "import:run",
      "person:create",
      "fact:create",
    ]),
    requestId: newId(),
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    workspaceId: actor.workspaceId,
  };
}

async function seedReferencedImport(input: {
  actor: SessionActor;
  fixture: ResearchFixture;
  mapping?: unknown;
  mode?: "COMMIT" | "DRY_RUN";
  recordKind: "PERSON" | "RELATIONSHIP";
  state: "completed" | "completed_with_errors" | "running";
}) {
  const fileId = newId();
  const importId = newId();
  await input.fixture.database.insert(filesTable).values({
    id: fileId,
    workspaceId: input.actor.workspaceId,
    storageProvider: "minio",
    storageBucket: "private",
    storageKey: `mapping-reference/${fileId}`,
    originalName: "reference.csv",
    mediaType: "text/csv",
    detectedType: "text/csv",
    byteSize: 1,
    checksum: `sha256:${"61".repeat(32)}`,
    quarantineState: "available",
    scanState: "not_required",
    ocrState: "not_requested",
    extractionState: "not_requested",
    uploadedBy: input.actor.userId,
    createdBy: input.actor.principalId,
    updatedBy: input.actor.principalId,
  });
  const definition =
    input.recordKind === "PERSON"
      ? {
          version: 1,
          recordKind: "PERSON",
          rowKeySource: "external_id",
          person: {
            displayNameSource: "name",
            primaryNameKind: "legal",
            fields: [],
          },
          facts: [],
          defaults: {},
        }
      : {
          version: 1,
          recordKind: "RELATIONSHIP",
          rowKeySource: "relationship_id",
          relationship: {
            typeId: newId(),
            sourcePerson: { kind: "PERSON_ID", source: "source_person_id" },
            targetPerson: { kind: "PERSON_ID", source: "target_person_id" },
            fields: [],
          },
          defaults: {},
        };
  await input.fixture.database.insert(importsTable).values({
    id: importId,
    workspaceId: input.actor.workspaceId,
    fileId,
    format: "CSV",
    state: input.state,
    mapping:
      input.mapping ??
      ({
        definition,
        mappingHash: "61".repeat(32),
        mappingId: newId(),
        mappingVersion: 1,
        mode: input.mode ?? "COMMIT",
        requestHash: "62".repeat(32),
      } as const),
    idempotencyKey: `mapping-reference-${importId}`,
    completedAt: input.state === "running" ? null : new Date(),
    createdBy: input.actor.userId,
    updatedBy: input.actor.userId,
  });
  return importId;
}

liveDescribe("import staging and durable start", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("uploads, replays, queues, and executes a mixed JSON import", async () => {
    const actor = await fixture.createActor("owner");
    const context = await serviceContext(fixture, actor);
    const store = new MemoryStore();
    const fileService = createFilesService(context, {
      encryptionKey,
      objectStore: store,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const body = new TextEncoder().encode(
      JSON.stringify([
        { external_id: "json-valid", name: "JSON Valid" },
        { external_id: "json-rejected" },
      ]),
    );
    const upload = await fileService.createUploadSession({
      originalName: "people.json",
      claimedMediaType: "application/json",
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      purpose: "JSON_IMPORT",
    });
    store.objects.set(`${actor.workspaceId}:${upload.session.objectKey}`, body);
    const completed = await fileService.completeUpload(upload.session.id);
    const service = createImportsService(context, {
      encryptionKey,
      objectStore: store,
    });
    const saved = await service.saveMapping({
      name: "JSON people",
      format: "JSON",
      definition: {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [],
        defaults: {},
      },
    });

    const prepared = await service.prepareImport({
      fileId: completed.file.id,
      mappingId: saved.mapping.id,
      idempotencyKey: "prepare-json-acceptance-v1",
      mode: "COMMIT",
    });
    expect(prepared.import).toMatchObject({
      format: "JSON",
      state: "preview_ready",
      totalRows: 2,
      rejectedRows: 1,
    });
    expect(prepared.preview).toMatchObject([
      {
        rowNumber: 1,
        state: "pending",
        normalizedPayload: { kind: "PERSON", rowKey: "json-valid" },
      },
      {
        rowNumber: 2,
        state: "rejected",
        issues: [
          {
            code: "ROW_VALIDATION_FAILED",
            message: "The row does not satisfy the selected mapping.",
          },
        ],
      },
    ]);
    const preparedReplay = await service.prepareImport({
      fileId: completed.file.id,
      mappingId: saved.mapping.id,
      idempotencyKey: "prepare-json-acceptance-v1",
      mode: "COMMIT",
    });
    expect(preparedReplay.import.id).toBe(prepared.import.id);

    const queued = await service.startImport({
      importId: prepared.import.id,
      expectedVersion: prepared.import.version,
      idempotencyKey: "run-json-acceptance-v1",
    });
    expect(queued.import).toMatchObject({ state: "queued" });
    const queuedReplay = await service.startImport({
      importId: prepared.import.id,
      expectedVersion: prepared.import.version,
      idempotencyKey: "run-json-acceptance-v1",
    });
    expect(queuedReplay.job.id).toBe(queued.job.id);

    await expect(
      runImportWorker(fixture, "019cc7c4-6ed2-7e0a-aed8-e5d451c96d01"),
    ).resolves.toMatchObject({ claimed: 1, completed: 1, deadLettered: 0 });

    const rows = await fixture.database
      .select()
      .from(importRows)
      .where(eq(importRows.importId, prepared.import.id));
    const succeeded = rows.find((row) => row.state === "succeeded");
    const rejected = rows.find((row) => row.state === "rejected");
    const [person] = await fixture.database
      .select({ id: people.id })
      .from(people)
      .where(eq(people.workspaceId, actor.workspaceId));
    expect(succeeded?.resultReferences).toHaveLength(3);
    expect(succeeded?.resultReferences).toContain(person?.id);
    expect(rejected).toMatchObject({
      resultReferences: [],
      validationErrors: [
        {
          code: "ROW_VALIDATION_FAILED",
          message: "The row does not satisfy the selected mapping.",
        },
      ],
    });
    const [storedImport] = await fixture.database
      .select()
      .from(importsTable)
      .where(eq(importsTable.id, prepared.import.id));
    expect(storedImport).toMatchObject({
      state: "completed_with_errors",
      totalRows: 2,
      acceptedRows: 1,
      rejectedRows: 1,
    });
  });

  it("retains one safe rejection diagnostic after the preview issue budget is spent", async () => {
    const actor = await fixture.createActor("owner");
    const context = await serviceContext(fixture, actor);
    const store = new MemoryStore();
    const fileService = createFilesService(context, {
      encryptionKey,
      objectStore: store,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const body = new TextEncoder().encode(
      JSON.stringify([
        ...Array.from({ length: 200 }, (_, index) => ({
          external_id: `formula-${index + 1}`,
          name: `=formula-${index + 1}`,
        })),
        { external_id: "private-rejected-row-key" },
      ]),
    );
    const upload = await fileService.createUploadSession({
      originalName: "bounded-diagnostics.json",
      claimedMediaType: "application/json",
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      purpose: "JSON_IMPORT",
    });
    store.objects.set(`${actor.workspaceId}:${upload.session.objectKey}`, body);
    const completed = await fileService.completeUpload(upload.session.id);
    const service = createImportsService(context, {
      encryptionKey,
      objectStore: store,
    });
    const mapping = await service.saveMapping({
      name: "Bounded JSON diagnostics",
      format: "JSON",
      definition: {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [],
        defaults: {},
      },
    });

    const prepared = await service.prepareImport({
      fileId: completed.file.id,
      mappingId: mapping.mapping.id,
      idempotencyKey: ["prepare", "bounded", "diagnostics", "v1"].join("-"),
      mode: "COMMIT",
    });
    expect(prepared.preview).toHaveLength(100);
    expect(prepared.import).toMatchObject({
      totalRows: 201,
      rejectedRows: 1,
    });
    const [rejected] = await fixture.database
      .select()
      .from(importRows)
      .where(
        and(
          eq(importRows.importId, prepared.import.id),
          eq(importRows.rowNumber, 201),
        ),
      );
    expect(rejected?.validationErrors).toEqual([
      {
        code: "ROW_VALIDATION_FAILED",
        message: "The row does not satisfy the selected mapping.",
      },
    ]);
    expect(JSON.stringify(rejected?.validationErrors)).not.toContain(
      "private-rejected-row-key",
    );
  });

  it("stages a verified CSV, replays preparation, and queues one sealed job", async () => {
    const actor = await fixture.createActor("owner");
    const [session] = await fixture.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, actor.userId))
      .limit(1);
    if (!session) throw new Error("fixture session is missing");
    const store = new MemoryStore();
    const limiter = {
      consume: async () => ({
        allowed: true,
        remainingMicrotokens: 1,
        retryAfterMs: 0,
      }),
    };
    const context = {
      actor: {
        type: "user" as const,
        id: actor.userId,
        memberId: actor.memberId,
        principalId: actor.principalId,
        role: "owner",
        sessionId: session.id,
      },
      database: fixture.database,
      operationLimiter: limiter,
      permissions: new Set([
        "file:create",
        "file:read",
        "import:create",
        "import:update",
        "import:read",
        "import:run",
        "person:create",
        "fact:create",
      ]),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    };
    const files = createFilesService(context, {
      encryptionKey,
      objectStore: store,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const body = new TextEncoder().encode(
      "external_id,name\np-1,Ada Lovelace\n",
    );
    const checksum = createHash("sha256").update(body).digest("hex");
    const upload = await files.createUploadSession({
      originalName: "people.csv",
      claimedMediaType: "text/csv",
      byteSize: body.byteLength,
      checksumSha256: checksum,
      purpose: "CSV_IMPORT",
    });
    store.objects.set(`${actor.workspaceId}:${upload.session.objectKey}`, body);
    const completed = await files.completeUpload(upload.session.id);
    const service = createImportsService(context, {
      encryptionKey,
      objectStore: store,
    });
    const saved = await service.saveMapping({
      name: "People",
      format: "CSV",
      definition: {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [],
        defaults: { status: "active", sensitivity: "internal" },
      },
    });
    store.openReadCalls = 0;
    store.openReadDelayMs = 5_250;
    const preparedResults = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.prepareImport({
          fileId: completed.file.id,
          mappingId: saved.mapping.id,
          idempotencyKey: "prepare-people-v1",
          mode: "COMMIT",
        }),
      ),
    );
    const prepared = preparedResults[0]!;
    expect(new Set(preparedResults.map((result) => result.import.id))).toEqual(
      new Set([prepared.import.id]),
    );
    expect(store.openReadCalls).toBe(1);
    store.openReadDelayMs = 0;
    expect(prepared.import).toMatchObject({
      state: "preview_ready",
      totalRows: 1,
    });
    expect(prepared.preview).toMatchObject([
      {
        rowNumber: 1,
        state: "pending",
        normalizedPayload: { kind: "PERSON", rowKey: "p-1" },
      },
    ]);
    await fixture.database
      .update(filesTable)
      .set({ sensitivity: "restricted" })
      .where(eq(filesTable.id, completed.file.id));
    await expect(
      service.prepareImport({
        fileId: completed.file.id,
        mappingId: saved.mapping.id,
        idempotencyKey: "prepare-people-v1",
        mode: "COMMIT",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: actor.workspaceId,
      name: "Prepared import source",
      sensitivityCeiling: "restricted",
      resourceKinds: ["file"],
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      policyId,
      memberId: actor.memberId,
      resourceId: completed.file.id,
      resourceKind: "file",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const replay = await service.prepareImport({
      fileId: completed.file.id,
      mappingId: saved.mapping.id,
      idempotencyKey: "prepare-people-v1",
      mode: "COMMIT",
    });
    expect(replay.import.id).toBe(prepared.import.id);
    expect(await fixture.database.select().from(importRows)).toHaveLength(1);

    await fixture.database
      .update(filesTable)
      .set({ checksum: `sha256:${"ff".repeat(32)}` })
      .where(eq(filesTable.id, completed.file.id));
    await expect(
      service.startImport({
        importId: prepared.import.id,
        expectedVersion: prepared.import.version,
        idempotencyKey: "run-people-drift-v1",
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    await fixture.database
      .update(filesTable)
      .set({ checksum: completed.file.checksum })
      .where(eq(filesTable.id, completed.file.id));

    const queued = await service.startImport({
      importId: prepared.import.id,
      expectedVersion: prepared.import.version,
      idempotencyKey: "run-people-v1",
    });
    expect(queued.import.state).toBe("queued");
    expect(
      createJobsService({ database: fixture.database, encryptionKey }).decode(
        queued.job,
      ),
    ).toEqual({ kind: "import_execute", importId: prepared.import.id });
    const queuedReplay = await service.startImport({
      importId: prepared.import.id,
      expectedVersion: prepared.import.version,
      idempotencyKey: "run-people-v1",
    });
    expect(queuedReplay.job.id).toBe(queued.job.id);
    expect(queuedReplay.import.executionJobId).toBe(queued.job.id);
    expect(
      await fixture.database
        .select()
        .from(jobs)
        .where(eq(jobs.kind, "import_execute")),
    ).toHaveLength(1);

    await fixture.database
      .update(jobs)
      .set({ state: "dead_letter" })
      .where(eq(jobs.id, queued.job.id));
    await fixture.database
      .update(importsTable)
      .set({ state: "dead_letter", version: queued.import.version + 1 })
      .where(eq(importsTable.id, queued.import.id));
    await expect(
      service.retryImport({
        importId: queued.import.id,
        expectedVersion: queued.import.version + 1,
        idempotencyKey: "run-people-v1",
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  }, 15_000);

  it("replays a job committed after the import was read but before the locked job lookup", async () => {
    const actor = await fixture.createActor("owner");
    const context = await serviceContext(fixture, actor);
    const store = new MemoryStore();
    const fileService = createFilesService(context, {
      encryptionKey,
      objectStore: store,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const body = new TextEncoder().encode(
      "external_id,name\np-race,Race Person\n",
    );
    const upload = await fileService.createUploadSession({
      originalName: "race.csv",
      claimedMediaType: "text/csv",
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      purpose: "CSV_IMPORT",
    });
    store.objects.set(`${actor.workspaceId}:${upload.session.objectKey}`, body);
    const completed = await fileService.completeUpload(upload.session.id);
    const service = createImportsService(context, {
      encryptionKey,
      objectStore: store,
    });
    const mapping = await service.saveMapping({
      name: "Race people",
      format: "CSV",
      definition: {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [],
        defaults: {},
      },
    });
    const prepared = await service.prepareImport({
      fileId: completed.file.id,
      mappingId: mapping.mapping.id,
      idempotencyKey: "prepare-race-v1",
      mode: "COMMIT",
    });
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    const blocker = postgres(databaseUrl, { max: 1, prepare: false });
    const observer = postgres(databaseUrl, { max: 1, prepare: false });
    const scope = `humans:imports:${actor.workspaceId}`;
    let blockerOpen = false;

    try {
      await blocker`BEGIN`;
      blockerOpen = true;
      await blocker`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
      const replayPromise = service.startImport({
        importId: prepared.import.id,
        expectedVersion: prepared.import.version,
        idempotencyKey: "run-race-v1",
      });

      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [activity] = await observer<[{ waiting: boolean }]>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event = 'advisory'
              AND query LIKE '%pg_advisory_xact_lock%'
          ) AS waiting
        `;
        if (activity?.waiting) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      expect(waiting).toBe(true);

      const committedJob = await createJobsService({
        database: fixture.database,
        encryptionKey,
      }).enqueue({
        workspaceId: actor.workspaceId,
        idempotencyKey: importJobIdempotencyHash({
          actorId: actor.userId,
          key: "run-race-v1",
          workspaceId: actor.workspaceId,
        }),
        payload: { kind: "import_execute", importId: prepared.import.id },
        requestHash: importJobRequestHash({
          actorId: actor.userId,
          expectedVersion: prepared.import.version,
          fileChecksum: completed.file.checksum,
          fileId: completed.file.id,
          fileSize: completed.file.byteSize,
          importId: prepared.import.id,
          mappingHash: (prepared.import.mapping as { mappingHash: string })
            .mappingHash,
          mappingId: mapping.mapping.id,
          mappingVersion: mapping.mapping.version,
          mode: "COMMIT",
          operation: "start",
          workspaceId: actor.workspaceId,
        }),
        createdBy: actor.userId,
      });
      await fixture.database
        .update(importsTable)
        .set({
          executionJobId: committedJob.id,
          state: "queued",
          version: prepared.import.version + 1,
        })
        .where(eq(importsTable.id, prepared.import.id));
      await blocker`COMMIT`;
      blockerOpen = false;

      await expect(replayPromise).resolves.toMatchObject({
        import: { executionJobId: committedJob.id, state: "queued" },
        job: { id: committedJob.id },
      });
    } finally {
      if (blockerOpen) await blocker`ROLLBACK`;
      await blocker.end();
      await observer.end();
    }
  });

  it.each([
    "role demotion",
    "membership removal",
    "session revocation",
    "workspace suspension",
  ] as const)(
    "rejects prepare when %s wins the live-authority race",
    async (revocation) => {
      const owner = await fixture.createActor("owner");
      const actor = await fixture.createWorkspaceMember(owner, "contributor");
      const ownerContext = await serviceContext(fixture, owner);
      const writerConnection = createTestConnection(1);
      const context = {
        ...(await serviceContext(fixture, actor)),
        database: createTestDatabase(writerConnection),
      };
      const store = new MemoryStore();
      const fileService = createFilesService(ownerContext, {
        encryptionKey,
        objectStore: store,
        storageBucket: "private",
        storageProvider: "minio",
      });
      const body = new TextEncoder().encode(
        "external_id,name\nrace-1,Locked User\n",
      );
      const upload = await fileService.createUploadSession({
        originalName: "authority-race.csv",
        claimedMediaType: "text/csv",
        byteSize: body.byteLength,
        checksumSha256: createHash("sha256").update(body).digest("hex"),
        purpose: "CSV_IMPORT",
      });
      store.objects.set(
        `${owner.workspaceId}:${upload.session.objectKey}`,
        body,
      );
      const completed = await fileService.completeUpload(upload.session.id);
      const ownerService = createImportsService(ownerContext, {
        encryptionKey,
        objectStore: store,
      });
      const mapping = await ownerService.saveMapping({
        name: "Authority race mapping",
        format: "CSV",
        definition: {
          version: 1,
          recordKind: "PERSON",
          rowKeySource: "external_id",
          person: {
            displayNameSource: "name",
            primaryNameKind: "legal",
            fields: [],
          },
          facts: [],
          defaults: {},
        },
      });
      const service = createImportsService(context, {
        encryptionKey,
        objectStore: store,
      });
      let preparePromise: Promise<
        Awaited<ReturnType<typeof service.prepareImport>>
      > | null = null;
      try {
        await fixture.connection.begin(async (revoker) => {
          if (
            revocation === "role demotion" ||
            revocation === "membership removal"
          ) {
            await revoker`
              SELECT id FROM members WHERE id = ${actor.memberId} FOR UPDATE
            `;
          } else if (revocation === "session revocation") {
            await revoker`
              SELECT id FROM sessions
              WHERE id = ${context.actor.sessionId}
              FOR UPDATE
            `;
          } else {
            await revoker`
              SELECT id FROM workspaces
              WHERE id = ${actor.workspaceId}
              FOR UPDATE
            `;
          }
          preparePromise = service.prepareImport({
            fileId: completed.file.id,
            mappingId: mapping.mapping.id,
            idempotencyKey: `prepare-${revocation.replaceAll(" ", "-")}-race-v1`,
          });
          if (revocation === "role demotion") {
            await revoker`
            UPDATE members SET role = 'viewer' WHERE id = ${actor.memberId}
          `;
          } else if (revocation === "membership removal") {
            await revoker`
            DELETE FROM members WHERE id = ${actor.memberId}
          `;
          } else if (revocation === "session revocation") {
            await revoker`
              UPDATE sessions
              SET expires_at = now() - interval '1 second'
              WHERE id = ${context.actor.sessionId}
            `;
          } else {
            await revoker`
              UPDATE workspaces
              SET state = 'inactive'
              WHERE id = ${actor.workspaceId}
            `;
          }
        });
        await expect(preparePromise).rejects.toMatchObject({
          extensions: { code: "FORBIDDEN" },
        });
        expect(
          await fixture.database
            .select({ id: importsTable.id })
            .from(importsTable)
            .where(eq(importsTable.workspaceId, actor.workspaceId)),
        ).toHaveLength(0);
      } finally {
        if (preparePromise) await Promise.allSettled([preparePromise]);
        await writerConnection.end();
      }
    },
  );

  it.each([
    "role demotion",
    "session revocation",
    "workspace suspension",
  ] as const)(
    "serializes %s behind a live-authorized prepare claim",
    async (revocation) => {
      const owner = await fixture.createActor("owner");
      const actor = await fixture.createWorkspaceMember(owner, "contributor");
      const ownerContext = await serviceContext(fixture, owner);
      const store = new MemoryStore();
      const fileService = createFilesService(ownerContext, {
        encryptionKey,
        objectStore: store,
        storageBucket: "private",
        storageProvider: "minio",
      });
      const body = new TextEncoder().encode(
        "external_id,name\nlock-1,Committed User\n",
      );
      const upload = await fileService.createUploadSession({
        originalName: "authority-lock.csv",
        claimedMediaType: "text/csv",
        byteSize: body.byteLength,
        checksumSha256: createHash("sha256").update(body).digest("hex"),
        purpose: "CSV_IMPORT",
      });
      store.objects.set(
        `${owner.workspaceId}:${upload.session.objectKey}`,
        body,
      );
      const completed = await fileService.completeUpload(upload.session.id);
      const ownerService = createImportsService(ownerContext, {
        encryptionKey,
        objectStore: store,
      });
      const mapping = await ownerService.saveMapping({
        name: "Authority lock mapping",
        format: "CSV",
        definition: {
          version: 1,
          recordKind: "PERSON",
          rowKeySource: "external_id",
          person: {
            displayNameSource: "name",
            primaryNameKind: "legal",
            fields: [],
          },
          facts: [],
          defaults: {},
        },
      });
      const writerConnection = createTestConnection(1);
      const revokerConnection = createTestConnection(1);
      const gateConnection = createTestConnection(1);
      const writerName = `task1_import_writer_${newId()}`;
      const revokerName = `task1_import_revoker_${newId()}`;
      const actorContext = await serviceContext(fixture, actor);
      const service = createImportsService(
        {
          ...actorContext,
          database: createTestDatabase(writerConnection),
        },
        { encryptionKey, objectStore: store },
      );
      let gateHeld = false;
      let preparePromise: Promise<
        Awaited<ReturnType<typeof service.prepareImport>>
      > | null = null;
      let removalPromise: Promise<unknown> | null = null;
      try {
        await fixture.connection.unsafe(`
        CREATE OR REPLACE FUNCTION task1_import_post_authority_gate()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.state = 'staging' AND NEW.state = 'preview_ready' THEN
            PERFORM pg_advisory_xact_lock(${IMPORT_PREPARE_GATE});
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER task1_import_post_authority_gate_trigger
        BEFORE UPDATE ON imports
        FOR EACH ROW EXECUTE FUNCTION task1_import_post_authority_gate();
      `);
        await writerConnection`SELECT set_config('application_name', ${writerName}, false)`;
        await revokerConnection`SELECT set_config('application_name', ${revokerName}, false)`;
        await gateConnection`SELECT pg_advisory_lock(${IMPORT_PREPARE_GATE})`;
        gateHeld = true;
        preparePromise = service.prepareImport({
          fileId: completed.file.id,
          mappingId: mapping.mapping.id,
          idempotencyKey: "prepare-authority-lock-v1",
        });
        await waitForActivity(fixture, writerName, "AdvisoryLock");
        const revokerDatabase = createTestDatabase(revokerConnection);
        if (revocation === "role demotion") {
          removalPromise = revokerDatabase
            .update(members)
            .set({ role: "viewer" })
            .where(eq(members.id, actor.memberId))
            .returning({ id: members.id })
            .then(() => undefined);
        } else if (revocation === "session revocation") {
          removalPromise = revokerDatabase
            .update(sessions)
            .set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(sessions.id, actorContext.actor.sessionId))
            .returning({ id: sessions.id })
            .then(() => undefined);
        } else {
          removalPromise = revokerDatabase
            .update(workspaces)
            .set({ state: "inactive" })
            .where(eq(workspaces.id, actor.workspaceId))
            .returning({ id: workspaces.id })
            .then(() => undefined);
        }
        await waitForActivity(fixture, revokerName, "Lock");
        await gateConnection`SELECT pg_advisory_unlock(${IMPORT_PREPARE_GATE})`;
        gateHeld = false;
        await expect(preparePromise).resolves.toMatchObject({
          import: { state: "preview_ready", totalRows: 1 },
        });
        await removalPromise;
        expect(
          await fixture.database
            .select({ id: importsTable.id })
            .from(importsTable)
            .where(eq(importsTable.workspaceId, owner.workspaceId)),
        ).toHaveLength(1);
      } finally {
        if (gateHeld) {
          await gateConnection`
          SELECT pg_advisory_unlock(${IMPORT_PREPARE_GATE})
        `.catch(() => undefined);
        }
        await fixture.connection
          .unsafe(
            "DROP TRIGGER IF EXISTS task1_import_post_authority_gate_trigger ON imports; DROP FUNCTION IF EXISTS task1_import_post_authority_gate();",
          )
          .catch(() => undefined);
        await Promise.allSettled(
          [preparePromise, removalPromise].filter(
            (promise): promise is Promise<unknown> => promise !== null,
          ),
        );
        await Promise.all([
          writerConnection.end(),
          revokerConnection.end(),
          gateConnection.end(),
        ]);
      }
    },
  );

  it("serializes the per-actor cap when a member starts imports created by a peer", async () => {
    const owner = await fixture.createActor("owner");
    const member = await fixture.createWorkspaceMember(owner, "contributor");
    const ownerContext = await serviceContext(fixture, owner);
    const memberContext = await serviceContext(fixture, member);
    const store = new MemoryStore();
    const files = createFilesService(ownerContext, {
      encryptionKey,
      objectStore: store,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const body = new TextEncoder().encode(
      "external_id,name\np-peer,Peer-created import\n",
    );
    const upload = await files.createUploadSession({
      originalName: "peer-created.csv",
      claimedMediaType: "text/csv",
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      purpose: "CSV_IMPORT",
    });
    store.objects.set(`${owner.workspaceId}:${upload.session.objectKey}`, body);
    const completed = await files.completeUpload(upload.session.id);
    const ownerService = createImportsService(ownerContext, {
      encryptionKey,
      objectStore: store,
    });
    const mapping = await ownerService.saveMapping({
      name: "Peer-created people",
      format: "CSV",
      definition: {
        version: 1,
        recordKind: "PERSON",
        rowKeySource: "external_id",
        person: {
          displayNameSource: "name",
          primaryNameKind: "legal",
          fields: [],
        },
        facts: [],
        defaults: {},
      },
    });
    const [first, second] = await Promise.all([
      ownerService.prepareImport({
        fileId: completed.file.id,
        mappingId: mapping.mapping.id,
        idempotencyKey: "prepare-peer-cap-1",
        mode: "COMMIT",
      }),
      ownerService.prepareImport({
        fileId: completed.file.id,
        mappingId: mapping.mapping.id,
        idempotencyKey: "prepare-peer-cap-2",
        mode: "COMMIT",
      }),
    ]);
    expect(first.import.createdBy).toBe(owner.userId);
    expect(second.import.createdBy).toBe(owner.userId);

    const memberService = createImportsService(memberContext, {
      encryptionKey,
      objectStore: store,
    });
    const results = await Promise.allSettled([
      memberService.startImport({
        importId: first.import.id,
        expectedVersion: first.import.version,
        idempotencyKey: "run-peer-cap-1",
      }),
      memberService.startImport({
        importId: second.import.id,
        expectedVersion: second.import.version,
        idempotencyKey: "run-peer-cap-2",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { extensions: { code: "RATE_LIMITED" } },
    });
    const active = await fixture.database
      .select({ importId: importsTable.id, jobCreatedBy: jobs.createdBy })
      .from(importsTable)
      .innerJoin(
        jobs,
        and(
          eq(jobs.workspaceId, importsTable.workspaceId),
          eq(jobs.id, importsTable.executionJobId),
        ),
      )
      .where(
        and(
          eq(importsTable.workspaceId, owner.workspaceId),
          eq(jobs.createdBy, member.userId),
        ),
      );
    expect(active).toHaveLength(1);
  });

  it("binds external relationship endpoints only to terminal same-workspace PERSON imports", async () => {
    const actor = await fixture.createActor("owner");
    const foreignActor = await fixture.createActor("owner");
    const context = await serviceContext(fixture, actor);
    const sourceImportId = await seedReferencedImport({
      actor,
      fixture,
      recordKind: "PERSON",
      state: "completed",
    });
    const targetImportId = await seedReferencedImport({
      actor,
      fixture,
      recordKind: "PERSON",
      state: "completed_with_errors",
    });
    const runningImportId = await seedReferencedImport({
      actor,
      fixture,
      recordKind: "PERSON",
      state: "running",
    });
    const wrongKindImportId = await seedReferencedImport({
      actor,
      fixture,
      recordKind: "RELATIONSHIP",
      state: "completed",
    });
    const foreignImportId = await seedReferencedImport({
      actor: foreignActor,
      fixture,
      recordKind: "PERSON",
      state: "completed",
    });
    const dryRunImportId = await seedReferencedImport({
      actor,
      fixture,
      mode: "DRY_RUN",
      recordKind: "PERSON",
      state: "completed",
    });
    const malformedImportId = await seedReferencedImport({
      actor,
      fixture,
      mapping: { definition: { recordKind: "PERSON" } },
      recordKind: "PERSON",
      state: "completed",
    });
    const relationshipTypeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: actor.workspaceId,
      namespace: "workspace",
      key: "imported-colleague",
      forwardLabel: "colleague of",
      inverseLabel: "colleague of",
      directed: false,
      allowsSelf: false,
      allowedMultiplicity: "many_to_many",
      state: "active",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const definition = (source: string, target: string) => ({
      version: 1 as const,
      recordKind: "RELATIONSHIP" as const,
      rowKeySource: "edge_id",
      relationship: {
        typeId: relationshipTypeId,
        sourcePerson: {
          kind: "EXTERNAL_KEY" as const,
          personImportId: source,
          source: "source_key",
        },
        targetPerson: {
          kind: "EXTERNAL_KEY" as const,
          personImportId: target,
          source: "target_key",
        },
        fields: [],
      },
      defaults: {},
    });
    const service = createImportsService(context, { encryptionKey });
    const saved = await service.saveMapping({
      name: "External relationships",
      format: "CSV",
      definition: definition(sourceImportId, targetImportId),
    });
    expect(saved.mapping.columnMapping).toMatchObject({
      relationship: {
        sourcePerson: { personImportId: sourceImportId },
        targetPerson: { personImportId: targetImportId },
      },
    });

    for (const [name, invalidImportId] of [
      ["Running source", runningImportId],
      ["Wrong-kind source", wrongKindImportId],
      ["Foreign source", foreignImportId],
      ["Dry-run source", dryRunImportId],
      ["Malformed source", malformedImportId],
    ] as const) {
      await expect(
        service.saveMapping({
          name,
          format: "CSV",
          definition: definition(invalidImportId, targetImportId),
        }),
      ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    }

    const store = new MemoryStore();
    const files = createFilesService(context, {
      encryptionKey,
      objectStore: store,
      storageBucket: "private",
      storageProvider: "minio",
    });
    const body = new TextEncoder().encode(
      "edge_id,source_key,target_key\nedge-1,source-1,target-1\n",
    );
    const checksum = createHash("sha256").update(body).digest("hex");
    const upload = await files.createUploadSession({
      originalName: "relationships.csv",
      claimedMediaType: "text/csv",
      byteSize: body.byteLength,
      checksumSha256: checksum,
      purpose: "CSV_IMPORT",
    });
    store.objects.set(`${actor.workspaceId}:${upload.session.objectKey}`, body);
    const completed = await files.completeUpload(upload.session.id);
    const [sourceImport] = await fixture.database
      .select({ mapping: importsTable.mapping })
      .from(importsTable)
      .where(eq(importsTable.id, sourceImportId));
    if (!sourceImport) throw new Error("source import fixture is missing");
    await fixture.database
      .update(importsTable)
      .set({ mapping: { definition: { recordKind: "PERSON" } } })
      .where(eq(importsTable.id, sourceImportId));
    await expect(
      createImportsService(context, {
        encryptionKey,
        objectStore: store,
      }).prepareImport({
        fileId: completed.file.id,
        mappingId: saved.mapping.id,
        idempotencyKey: "prepare-relationships-malformed-v1",
        mode: "COMMIT",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await fixture.database
      .update(importsTable)
      .set({
        mapping: sourceImport.mapping,
        state: "running",
        completedAt: null,
      })
      .where(eq(importsTable.id, sourceImportId));
    await expect(
      createImportsService(context, {
        encryptionKey,
        objectStore: store,
      }).prepareImport({
        fileId: completed.file.id,
        mappingId: saved.mapping.id,
        idempotencyKey: "prepare-relationships-v1",
        mode: "COMMIT",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
