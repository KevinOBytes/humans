// @vitest-environment node

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { extractionRuns, files } from "@/db/schema/files";
import { workspaceUsage } from "@/db/schema/workspaces";
import {
  CompleteWorkspaceUploadDocument,
  CreateWorkspaceUploadDocument,
  EvidenceFilesDocument,
  ImportHistoryDocument,
  ImportMappingOptionsDocument,
  ImportRowDiagnosticsDocument,
  PendingWorkspaceUploadsDocument,
  PrepareWorkspaceImportDocument,
  SaveWorkspaceImportMappingDocument,
  StartWorkspaceImportDocument,
} from "@/graphql/generated/graphql";
import type { ObjectStore } from "@/lib/storage/types";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "31".repeat(32);

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploadInputs: Array<{ key: string; workspaceId: string }> = [];
  beforeOpenRead?: () => Promise<void>;

  async createUpload(input: {
    bytes: number;
    checksumSha256: string;
    contentType: string;
    key: string;
    workspaceId: string;
  }) {
    this.uploadInputs.push({ key: input.key, workspaceId: input.workspaceId });
    return {
      contentLength: input.bytes,
      expiresAt: new Date(Date.now() + 300_000),
      headers: { "content-type": input.contentType },
      method: "PUT" as const,
      url: "https://storage.example/upload",
    };
  }

  async createDownload() {
    return {
      expiresAt: new Date(Date.now() + 120_000),
      headers: {},
      method: "GET" as const,
      url: "https://storage.example/download",
    };
  }

  async checkReachability() {}

  async getMetadata(input: { key: string; workspaceId: string }) {
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body ? { bytes: body.byteLength, custom: {} } : null;
  }

  async openRead(input: { key: string; workspaceId: string }) {
    await this.beforeOpenRead?.();
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body
      ? { body: Readable.from([body]), bytes: body.byteLength }
      : null;
  }

  async exists(input: { key: string; workspaceId: string }) {
    return this.objects.has(`${input.workspaceId}:${input.key}`);
  }

  async delete(input: { key: string; workspaceId: string }) {
    this.objects.delete(`${input.workspaceId}:${input.key}`);
  }
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing generated ${label}`);
  return value;
}

liveDescribe("generated files and imports product inventory", () => {
  let fixture: ResearchFixture;
  let store: MemoryObjectStore;

  beforeAll(() => {
    store = new MemoryObjectStore();
    fixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey,
        objectStore: store,
        storageBucket: "private",
        storageProvider: "minio",
      },
      importRuntime: { encryptionKey, objectStore: store },
    });
  });
  beforeEach(async () => {
    store.objects.clear();
    store.uploadInputs.length = 0;
    store.beforeOpenRead = undefined;
    await fixture.reset();
  });
  afterAll(async () => fixture.close());

  async function uploadAndComplete(input: {
    actor: SessionActor;
    body: Uint8Array;
    mediaType: string;
    name: string;
    purpose: "CSV_IMPORT" | "EVIDENCE" | "JSON_IMPORT";
  }) {
    const digest = createHash("sha256").update(input.body).digest("hex");
    const created = await fixture.execute<{
      createUploadSession: {
        grant: { method: string; url: string } | null;
        issues: unknown[];
        session: { id: string; state: string } | null;
      };
    }>({
      jar: input.actor.jar,
      operationName: "CreateWorkspaceUpload",
      query: CreateWorkspaceUploadDocument,
      variables: {
        input: {
          byteSize: input.body.byteLength,
          checksumSha256: digest,
          claimedMediaType: input.mediaType,
          originalName: input.name,
          purpose: input.purpose,
        },
      },
    });
    expect(created.body?.errors).toBeUndefined();
    expect(created.body?.data?.createUploadSession).toMatchObject({
      grant: { method: "PUT" },
      issues: [],
      session: { state: "PENDING" },
    });
    const sessionId = required(
      created.body?.data?.createUploadSession.session?.id,
      "upload session",
    );
    const upload = required(store.uploadInputs.at(-1), "upload grant input");
    expect(upload.workspaceId).toBe(input.actor.workspaceId);
    store.objects.set(`${upload.workspaceId}:${upload.key}`, input.body);

    const completed = await fixture.execute<{
      completeUpload: {
        file: {
          availability: string;
          id: string;
          originalName: string;
          scanState: string;
          version: number;
        } | null;
        issues: unknown[];
        session: { id: string; state: string } | null;
      };
    }>({
      jar: input.actor.jar,
      operationName: "CompleteWorkspaceUpload",
      query: CompleteWorkspaceUploadDocument,
      variables: { uploadSessionId: sessionId },
    });
    expect(completed.body?.errors).toBeUndefined();
    expect(completed.body?.data?.completeUpload).toMatchObject({
      file: {
        availability: "AVAILABLE",
        originalName: input.name,
        scanState: "NOT_REQUIRED",
      },
      issues: [],
      session: { id: sessionId, state: "COMPLETED" },
    });
    return required(completed.body?.data?.completeUpload.file, "file");
  }

  it("completes a generated upload and reads the durable file without crossing authority", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const body = new TextEncoder().encode("generated evidence body");

    const pending = await fixture.execute({
      jar: owner.jar,
      operationName: "CreateWorkspaceUpload",
      query: CreateWorkspaceUploadDocument,
      variables: {
        input: {
          byteSize: body.byteLength,
          checksumSha256: createHash("sha256").update(body).digest("hex"),
          claimedMediaType: "text/plain",
          originalName: "pending-evidence.txt",
          purpose: "EVIDENCE",
        },
      },
    });
    expect(pending.body?.errors).toBeUndefined();
    const pendingSessionId = required(
      (
        pending.body?.data?.createUploadSession as
          { session?: { id?: string } } | undefined
      )?.session?.id,
      "pending session",
    );
    const pendingRead = await fixture.execute<{
      uploadSessions: { nodes: Array<{ id: string; state: string }> };
    }>({
      jar: owner.jar,
      operationName: "PendingWorkspaceUploads",
      query: PendingWorkspaceUploadsDocument,
    });
    expect(pendingRead.body?.data?.uploadSessions.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pendingSessionId, state: "PENDING" }),
      ]),
    );

    const file = await uploadAndComplete({
      actor: owner,
      body,
      mediaType: "text/plain",
      name: "generated-evidence.txt",
      purpose: "EVIDENCE",
    });
    const files = await fixture.execute<{
      files: {
        nodes: Array<{
          availability: string;
          id: string;
          originalName: string;
        }>;
      };
    }>({
      jar: owner.jar,
      operationName: "EvidenceFiles",
      query: EvidenceFilesDocument,
      variables: { first: 1 },
    });
    expect(files.body?.errors).toBeUndefined();
    expect(files.body?.data?.files.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: "AVAILABLE",
          id: file.id,
          originalName: "generated-evidence.txt",
        }),
      ]),
    );

    const key = await fixture.provisionKey(owner, {
      file: ["create", "read"],
    });
    expectGraphQLError(
      await fixture.execute({
        apiKey: key.key,
        operationName: "CreateWorkspaceUpload",
        origin: null,
        query: CreateWorkspaceUploadDocument,
        variables: {
          input: {
            byteSize: 1,
            checksumSha256: "ab".repeat(32),
            claimedMediaType: "text/plain",
            originalName: "denied.txt",
            purpose: "EVIDENCE",
          },
        },
      }),
      "FORBIDDEN",
    );
    const foreignFiles = await fixture.execute<{
      files: { nodes: unknown[] };
    }>({
      jar: foreign.jar,
      operationName: "EvidenceFiles",
      query: EvidenceFilesDocument,
      variables: { first: 1 },
    });
    expect(foreignFiles.body?.data?.files.nodes).toEqual([]);
    expect(JSON.stringify(foreignFiles.body)).not.toContain(file.id);
    expect(JSON.stringify(fixture.capturedLogs)).not.toContain(
      "generated evidence body",
    );
  });

  it("replays create-session references, converges concurrent callers, and fences expiry, corruption, and tenants", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const body = new TextEncoder().encode("idempotent upload body");
    const input = {
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      claimedMediaType: "text/plain",
      originalName: "idempotent-upload.txt",
      purpose: "EVIDENCE",
      idempotencyKey: "file-session-replay-v1",
    };
    const [first, replay] = await Promise.all([
      fixture.execute<{
        createUploadSession: { session: { id: string }; grant: unknown };
      }>({
        jar: owner.jar,
        operationName: "CreateWorkspaceUpload",
        query: CreateWorkspaceUploadDocument,
        variables: { input },
      }),
      fixture.execute<{
        createUploadSession: { session: { id: string }; grant: unknown };
      }>({
        jar: owner.jar,
        operationName: "CreateWorkspaceUpload",
        query: CreateWorkspaceUploadDocument,
        variables: { input },
      }),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const firstSessionId = required(
      first.body?.data?.createUploadSession.session.id,
      "first idempotent upload session",
    );
    expect(replay.body?.data?.createUploadSession.session.id).toBe(
      firstSessionId,
    );
    const sessions = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.actorId, owner.userId),
          eq(idempotencyKeys.operation, "file.upload.session.create"),
        ),
      );
    expect(sessions).toHaveLength(1);
    const [claim] = await fixture.database
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.id, required(sessions[0]?.id, "claim")));
    expect(claim?.responseReference).toEqual({
      uploadSessionId: firstSessionId,
    });

    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { uploadSessionId: "not-a-uuid" } })
      .where(eq(idempotencyKeys.id, required(claim?.id, "claim id")));
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateWorkspaceUpload",
        query: CreateWorkspaceUploadDocument,
        variables: { input },
      }),
      "PRECONDITION_FAILED",
    );

    const takeoverInput = {
      ...input,
      idempotencyKey: "file-session-expiry-v1",
    };
    const beforeExpiry = await fixture.execute<{
      createUploadSession: { session: { id: string } };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceUpload",
      query: CreateWorkspaceUploadDocument,
      variables: { input: takeoverInput },
    });
    const beforeExpiryId = required(
      beforeExpiry.body?.data?.createUploadSession.session.id,
      "pre-expiry upload session",
    );
    const takeoverClaims = await fixture.database
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.operation, "file.upload.session.create"));
    const takeoverClaim = takeoverClaims.find(
      (row) =>
        (row.responseReference as { uploadSessionId?: unknown } | null)
          ?.uploadSessionId === beforeExpiryId,
    );
    await fixture.database
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(
        eq(idempotencyKeys.id, required(takeoverClaim?.id, "takeover claim")),
      );
    const takeover = await fixture.execute<{
      createUploadSession: { session: { id: string } };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceUpload",
      query: CreateWorkspaceUploadDocument,
      variables: { input: takeoverInput },
    });
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeover.body?.data?.createUploadSession.session.id).not.toBe(
      beforeExpiryId,
    );

    const foreignUpload = await fixture.execute<{
      createUploadSession: { session: { id: string } };
    }>({
      jar: foreign.jar,
      operationName: "CreateWorkspaceUpload",
      query: CreateWorkspaceUploadDocument,
      variables: { input },
    });
    expect(foreignUpload.body?.errors).toBeUndefined();
    expect(foreignUpload.body?.data?.createUploadSession.session.id).not.toBe(
      firstSessionId,
    );
  });

  it("replays and converges generated complete-upload claims with malformed, expiry, and workspace fencing", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const body = new TextEncoder().encode("complete upload idempotency body");
    const digest = createHash("sha256").update(body).digest("hex");
    const created = await fixture.execute<{
      createUploadSession: { session: { id: string } };
    }>({
      jar: owner.jar,
      operationName: "CreateWorkspaceUpload",
      query: CreateWorkspaceUploadDocument,
      variables: {
        input: {
          byteSize: body.byteLength,
          checksumSha256: digest,
          claimedMediaType: "text/plain",
          originalName: "complete-idempotency.txt",
          purpose: "EVIDENCE",
        },
      },
    });
    const uploadSessionId = required(
      created.body?.data?.createUploadSession.session.id,
      "complete upload session",
    );
    const upload = required(store.uploadInputs.at(-1), "complete upload grant");
    store.objects.set(`${upload.workspaceId}:${upload.key}`, body);
    const idempotencyKey = "file-complete-replay-v1";
    let releaseVerification!: () => void;
    const verificationBarrier = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationReads = 0;
    store.beforeOpenRead = async () => {
      verificationReads += 1;
      if (verificationReads === 1) await verificationBarrier;
    };
    const firstPromise = fixture.execute<{
      completeUpload: {
        file: { id: string };
        session: { id: string; state: string };
      };
    }>({
      jar: owner.jar,
      operationName: "CompleteWorkspaceUpload",
      query: CompleteWorkspaceUploadDocument,
      variables: { uploadSessionId, idempotencyKey },
    });
    while (verificationReads < 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const concurrentPromise = fixture.execute<{
      completeUpload: {
        file: { id: string };
        session: { id: string; state: string };
      };
    }>({
      jar: owner.jar,
      operationName: "CompleteWorkspaceUpload",
      query: CompleteWorkspaceUploadDocument,
      variables: { uploadSessionId, idempotencyKey },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseVerification();
    const [first, concurrent] = await Promise.all([
      firstPromise,
      concurrentPromise,
    ]);
    store.beforeOpenRead = undefined;
    expect(verificationReads).toBeGreaterThanOrEqual(1);
    expect(first.body?.errors).toBeUndefined();
    expect(concurrent.body?.errors).toBeUndefined();
    const firstResult = required(
      first.body?.data?.completeUpload,
      "first complete upload result",
    );
    const concurrentResult = required(
      concurrent.body?.data?.completeUpload,
      "concurrent complete upload result",
    );
    expect(firstResult.session).toMatchObject({
      id: uploadSessionId,
      state: "COMPLETED",
    });
    expect(concurrentResult.session).toMatchObject({
      id: uploadSessionId,
      state: "COMPLETED",
    });
    expect(concurrentResult.file.id).toBe(firstResult.file.id);

    const [claim] = await fixture.database
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.actorId, owner.userId),
          eq(idempotencyKeys.operation, "file.upload.complete"),
        ),
      );
    expect(claim?.status).toBe("completed");
    expect(claim?.responseReference).toEqual({
      fileId: firstResult.file.id,
      uploadSessionId,
    });
    const persistedFiles = await fixture.database
      .select({ id: files.id })
      .from(files)
      .where(eq(files.workspaceId, owner.workspaceId));
    expect(persistedFiles).toHaveLength(1);
    const completionAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "file.upload_completed"),
          eq(auditEvents.resourceId, firstResult.file.id),
        ),
      );
    expect(completionAudits).toHaveLength(1);
    const [usage] = await fixture.database
      .select({ storageBytes: workspaceUsage.storageBytes })
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, owner.workspaceId));
    expect(usage?.storageBytes).toBe(String(body.byteLength));

    await fixture.database
      .update(idempotencyKeys)
      .set({ responseReference: { fileId: ["invalid"], uploadSessionId } })
      .where(eq(idempotencyKeys.id, required(claim?.id, "complete claim")));
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CompleteWorkspaceUpload",
        query: CompleteWorkspaceUploadDocument,
        variables: { uploadSessionId, idempotencyKey },
      }),
      "VALIDATION_FAILED",
    );

    await fixture.database
      .update(idempotencyKeys)
      .set({
        responseReference: {
          fileId: firstResult.file.id,
          uploadSessionId,
        },
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(idempotencyKeys.id, required(claim?.id, "complete claim")));
    const takeover = await fixture.execute<{
      completeUpload: { file: { id: string }; session: { state: string } };
    }>({
      jar: owner.jar,
      operationName: "CompleteWorkspaceUpload",
      query: CompleteWorkspaceUploadDocument,
      variables: { uploadSessionId, idempotencyKey },
    });
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeover.body?.data?.completeUpload).toMatchObject({
      file: { id: firstResult.file.id },
      session: { state: "COMPLETED" },
    });

    expectGraphQLError(
      await fixture.execute({
        jar: foreign.jar,
        operationName: "CompleteWorkspaceUpload",
        query: CompleteWorkspaceUploadDocument,
        variables: { uploadSessionId, idempotencyKey },
      }),
      "NOT_FOUND",
    );
  });

  it("saves, prepares, queues, and reads a generated import with bounded denial", async () => {
    const owner = await fixture.createActor();
    const viewer = await fixture.createWorkspaceMember(owner, "viewer");
    const foreign = await fixture.createActor();
    const body = new TextEncoder().encode(
      JSON.stringify([
        { external_id: "generated-valid", name: "Generated Valid" },
        { external_id: "generated-rejected" },
      ]),
    );
    const file = await uploadAndComplete({
      actor: owner,
      body,
      mediaType: "application/json",
      name: "generated-people.json",
      purpose: "JSON_IMPORT",
    });
    const definition = {
      defaults: {},
      facts: [],
      person: {
        displayNameSource: "name",
        fields: [],
        primaryNameKind: "legal",
      },
      recordKind: "PERSON",
      rowKeySource: "external_id",
      version: 1,
    };

    const saved = await fixture.execute<{
      saveImportMapping: {
        issues: unknown[];
        mapping: { definition: unknown; id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      operationName: "SaveWorkspaceImportMapping",
      query: SaveWorkspaceImportMappingDocument,
      variables: {
        input: {
          definition,
          format: "JSON",
          name: "Generated people mapping",
        },
      },
    });
    expect(saved.body?.errors).toBeUndefined();
    expect(saved.body?.data?.saveImportMapping.issues).toEqual([]);
    const mapping = required(
      saved.body?.data?.saveImportMapping.mapping,
      "import mapping",
    );
    const mappings = await fixture.execute<{
      importMappings: { nodes: Array<{ id: string; name: string }> };
    }>({
      jar: owner.jar,
      operationName: "ImportMappingOptions",
      query: ImportMappingOptionsDocument,
    });
    expect(mappings.body?.data?.importMappings.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: mapping.id,
          name: "Generated people mapping",
        }),
      ]),
    );

    const prepared = await fixture.execute<{
      prepareImport: {
        import: {
          id: string;
          rejectedRows: number;
          state: string;
          totalRows: number;
          version: number;
        } | null;
        issues: unknown[];
        preview: Array<{ rowNumber: number; state: string }>;
      };
    }>({
      jar: owner.jar,
      operationName: "PrepareWorkspaceImport",
      query: PrepareWorkspaceImportDocument,
      variables: {
        input: {
          fileId: file.id,
          idempotencyKey: crypto.randomUUID(),
          mappingId: mapping.id,
          mode: "COMMIT",
        },
      },
    });
    expect(prepared.body?.errors).toBeUndefined();
    expect(prepared.body?.data?.prepareImport).toMatchObject({
      import: {
        rejectedRows: 1,
        state: "PREVIEW_READY",
        totalRows: 2,
      },
      issues: [],
      preview: [
        { rowNumber: 1, state: "pending" },
        { rowNumber: 2, state: "rejected" },
      ],
    });
    const preparedImport = required(
      prepared.body?.data?.prepareImport.import,
      "prepared import",
    );

    const started = await fixture.execute<{
      startImport: {
        import: { id: string; state: string; version: number } | null;
        issues: unknown[];
        job: { id: string; kind: string; state: string } | null;
      };
    }>({
      jar: owner.jar,
      operationName: "StartWorkspaceImport",
      query: StartWorkspaceImportDocument,
      variables: {
        expectedVersion: preparedImport.version,
        idempotencyKey: crypto.randomUUID(),
        importId: preparedImport.id,
      },
    });
    expect(started.body?.errors).toBeUndefined();
    expect(started.body?.data?.startImport).toMatchObject({
      import: { id: preparedImport.id, state: "QUEUED" },
      issues: [],
      job: { kind: "import_execute", state: "queued" },
    });

    const history = await fixture.execute<{
      imports: { nodes: Array<{ id: string; state: string }> };
    }>({
      jar: owner.jar,
      operationName: "ImportHistory",
      query: ImportHistoryDocument,
      variables: { first: 10 },
    });
    expect(history.body?.data?.imports.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: preparedImport.id, state: "QUEUED" }),
      ]),
    );
    const diagnostics = await fixture.execute<{
      importRows: {
        nodes: Array<{ rowNumber: number; state: string }>;
      };
    }>({
      jar: owner.jar,
      operationName: "ImportRowDiagnostics",
      query: ImportRowDiagnosticsDocument,
      variables: { first: 10, importId: preparedImport.id },
    });
    expect(diagnostics.body?.data?.importRows.nodes).toMatchObject([
      { rowNumber: 1, state: "pending" },
      { rowNumber: 2, state: "rejected" },
    ]);

    expectGraphQLError(
      await fixture.execute({
        jar: viewer.jar,
        operationName: "StartWorkspaceImport",
        query: StartWorkspaceImportDocument,
        variables: {
          expectedVersion: preparedImport.version,
          idempotencyKey: crypto.randomUUID(),
          importId: preparedImport.id,
        },
      }),
      "FORBIDDEN",
    );
    const foreignHistory = await fixture.execute<{
      imports: { nodes: unknown[] };
    }>({
      jar: foreign.jar,
      operationName: "ImportHistory",
      query: ImportHistoryDocument,
      variables: { first: 10 },
    });
    expect(foreignHistory.body?.data?.imports.nodes).toEqual([]);
    expectGraphQLError(
      await fixture.execute({
        jar: foreign.jar,
        operationName: "ImportRowDiagnostics",
        query: ImportRowDiagnosticsDocument,
        variables: { first: 10, importId: preparedImport.id },
      }),
      "NOT_FOUND",
    );
    const foreignSerialized = JSON.stringify(foreignHistory.body);
    expect(foreignSerialized).not.toContain(preparedImport.id);
    expect(foreignSerialized).not.toContain("Generated Valid");
  });

  it("keeps extraction runs and import mapping options scoped to the active workspace", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const file = await uploadAndComplete({
      actor: owner,
      body: new TextEncoder().encode("workspace-scoped extraction input"),
      mediaType: "text/plain",
      name: "extraction-input.txt",
      purpose: "EVIDENCE",
    });

    const saved = await fixture.execute<{
      saveImportMapping: { mapping: { id: string } | null; issues: unknown[] };
    }>({
      jar: owner.jar,
      operationName: "SaveWorkspaceImportMapping",
      query: SaveWorkspaceImportMappingDocument,
      variables: {
        input: {
          definition: {
            defaults: {},
            facts: [],
            person: {
              displayNameSource: "name",
              fields: [],
              primaryNameKind: "legal",
            },
            recordKind: "PERSON",
            rowKeySource: "external_id",
            version: 1,
          },
          format: "JSON",
          name: "Owner-only mapping",
        },
      },
    });
    expect(saved.body?.errors).toBeUndefined();
    expect(saved.body?.data?.saveImportMapping.issues).toEqual([]);
    expect(saved.body?.data?.saveImportMapping.mapping?.id).toEqual(
      expect.any(String),
    );

    const extractionRunId = crypto.randomUUID();
    await fixture.database.insert(extractionRuns).values({
      id: extractionRunId,
      workspaceId: owner.workspaceId,
      fileId: file.id,
      extractor: "plain-text",
      extractorVersion: "test-1",
      state: "completed",
      structuredOutput: { text: "workspace scoped" },
      createdBy: owner.userId,
    });

    const extractionQuery = /* GraphQL */ `
      query ExtractionRuns($fileId: UUID!) {
        extractionRuns(fileId: $fileId) {
          id
          fileId
          state
          structuredOutput
        }
      }
    `;
    const ownerRuns = await fixture.execute<{
      extractionRuns: Array<{ id: string; fileId: string; state: string }>;
    }>({
      jar: owner.jar,
      query: extractionQuery,
      variables: { fileId: file.id },
    });
    expect(ownerRuns.body?.errors).toBeUndefined();
    expect(ownerRuns.body?.data?.extractionRuns).toEqual([
      expect.objectContaining({
        id: extractionRunId,
        fileId: file.id,
        state: "COMPLETED",
      }),
    ]);

    const ownerMappings = await fixture.execute<{
      importMappings: { nodes: Array<{ id: string }> };
    }>({
      jar: owner.jar,
      operationName: "ImportMappingOptions",
      query: ImportMappingOptionsDocument,
    });
    expect(ownerMappings.body?.errors).toBeUndefined();
    expect(ownerMappings.body?.data?.importMappings.nodes).toEqual([
      expect.objectContaining({
        id: saved.body?.data?.saveImportMapping.mapping?.id,
      }),
    ]);

    const foreignRuns = await fixture.execute({
      jar: foreign.jar,
      query: extractionQuery,
      variables: { fileId: file.id },
    });
    expectGraphQLError(foreignRuns, "NOT_FOUND");
    expect(JSON.stringify(foreignRuns.body)).not.toContain(extractionRunId);

    const foreignMappings = await fixture.execute<{
      importMappings: { nodes: unknown[] };
    }>({
      jar: foreign.jar,
      operationName: "ImportMappingOptions",
      query: ImportMappingOptionsDocument,
    });
    expect(foreignMappings.body?.errors).toBeUndefined();
    expect(foreignMappings.body?.data?.importMappings.nodes).toEqual([]);
    expect(JSON.stringify(foreignMappings.body)).not.toContain(
      saved.body?.data?.saveImportMapping.mapping?.id,
    );
  });
});
