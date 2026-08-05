// @vitest-environment node

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { sessions } from "@/db/schema/auth";
import { newId } from "@/db/id";
import { fileVariants, files, uploadSessions } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import { workspacePrincipals } from "@/db/schema/principals";
import {
  accessPolicies,
  resourceGrants,
  workspaceUsage,
} from "@/db/schema/workspaces";
import type { ObjectStore } from "@/lib/storage/types";
import { archivedFileCleanupIdempotencyKey } from "@/modules/files/cleanup";
import { createFilesService } from "@/modules/files/service";
import type { FileScanner } from "@/modules/files/scanner";
import { decodeJobPayload } from "@/modules/jobs/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(
  fixture: ResearchFixture,
  queryFragment: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [{ blocked }] = await fixture.connection<[{ blocked: boolean }]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE ${`%${queryFragment}%`}
      ) AS blocked
    `;
    if (blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected a database lock waiter for ${queryFragment}`);
}

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploadInputs: Array<{ workspaceId: string; key: string }> = [];
  uploadCalls = 0;
  beforeCreateUpload?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;

  async createUpload(input: {
    workspaceId: string;
    key: string;
    bytes: number;
    contentType: string;
    checksumSha256: string;
  }) {
    this.uploadCalls += 1;
    this.uploadInputs.push({ workspaceId: input.workspaceId, key: input.key });
    await this.beforeCreateUpload?.();
    return {
      method: "PUT" as const,
      url: "https://storage.example/upload",
      expiresAt: new Date(Date.now() + 300_000),
      contentLength: input.bytes,
      headers: { "content-type": input.contentType },
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
    const body = this.objects.get(`${input.workspaceId}:${input.key}`);
    return body
      ? { bytes: body.byteLength, body: Readable.from([body]) }
      : null;
  }
  async exists(input: { workspaceId: string; key: string }) {
    return this.objects.has(`${input.workspaceId}:${input.key}`);
  }
  async delete(input: { workspaceId: string; key: string }) {
    await this.beforeDelete?.();
    this.objects.delete(`${input.workspaceId}:${input.key}`);
  }
}

async function fileServiceFor(
  fixture: ResearchFixture,
  actor: SessionActor,
  store: MemoryObjectStore,
  role: "admin" | "analyst" | "contributor" | "owner" | "viewer" = "owner",
  scanner?: FileScanner,
) {
  const [session] = await fixture.database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, actor.userId))
    .limit(1);
  if (!session) throw new Error("fixture session is missing");
  return createFilesService(
    {
      actor: {
        type: "user",
        id: actor.userId,
        memberId: actor.memberId,
        principalId: actor.principalId,
        role,
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
      permissions: new Set(["file:create", "file:delete", "file:read"]),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    },
    {
      deploymentMode: "docker",
      encryptionKey: "31".repeat(32),
      objectStore: store,
      scanner,
      storageBucket: "private",
      storageProvider: "minio",
    },
  );
}

async function apiKeyFileServiceFor(input: {
  fixture: ResearchFixture;
  keyId: string;
  permissions: readonly string[];
  store: MemoryObjectStore;
  workspaceId: string;
}) {
  const [principal] = await input.fixture.database
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.apiKeyId, input.keyId),
      ),
    )
    .limit(1);
  if (!principal) throw new Error("API-key principal is missing");
  return createFilesService(
    {
      actor: {
        type: "apiKey",
        id: input.keyId,
        principalId: principal.id,
        role: null,
      },
      database: input.fixture.database,
      operationLimiter: {
        consume: async () => ({
          allowed: true,
          remainingMicrotokens: 1,
          retryAfterMs: 0,
        }),
      },
      permissions: new Set(input.permissions),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: input.workspaceId,
    },
    {
      deploymentMode: "docker",
      encryptionKey: "31".repeat(32),
      objectStore: input.store,
      storageBucket: "private",
      storageProvider: "minio",
    },
  );
}

liveDescribe("file service", () => {
  let fixture: ResearchFixture;
  let store: MemoryObjectStore;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    store = new MemoryObjectStore();
  });
  afterAll(async () => fixture.close());

  it("creates an opaque upload session and verifies stored bytes", async () => {
    const actor = await fixture.createActor("owner");
    const [session] = await fixture.database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, actor.userId))
      .limit(1);
    if (!session) throw new Error("fixture session is missing");
    const service = createFilesService(
      {
        actor: {
          type: "user",
          id: actor.userId,
          memberId: actor.memberId,
          principalId: actor.principalId,
          role: "owner",
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
        permissions: new Set(["file:create", "file:read"]),
        requestId: "01900000-0000-7000-8000-000000000099",
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        workspaceId: actor.workspaceId,
      },
      {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: store,
        storageBucket: "private",
        storageProvider: "minio",
      },
    );
    const body = new TextEncoder().encode("safe evidence");
    const digest = createHash("sha256").update(body).digest("hex");
    const created = await service.createUploadSession({
      byteSize: body.byteLength,
      checksumSha256: digest,
      claimedMediaType: "text/plain",
      originalName: "evidence.txt",
      purpose: "EVIDENCE",
    });
    expect(created.session.objectKey).toMatch(
      /^uploads\/[0-9a-f-]+\/[0-9a-f-]+$/u,
    );
    expect(created.session.objectKey).not.toContain("evidence");
    store.objects.set(
      `${actor.workspaceId}:${created.session.objectKey}`,
      body,
    );

    const completed = await service.completeUpload(created.session.id);
    expect(completed.file).toMatchObject({
      byteSize: body.byteLength,
      checksum: `sha256:${digest}`,
      quarantineState: "available",
      scanState: "not_required",
    });
    const [usage] = await fixture.database
      .select({ id: workspaceUsage.id })
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, actor.workspaceId));
    expect(usage?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await expect(
      service.completeUpload(created.session.id),
    ).resolves.toMatchObject({
      file: { id: completed.file.id },
    });
  });

  it("fails closed for unavailable and infected scanners, preventing download grants", async () => {
    const actor = await fixture.createActor("owner");
    const body = new TextEncoder().encode("scanner-bound evidence");
    const checksum = createHash("sha256").update(body).digest("hex");
    const vectors: Array<{
      expected: { availability: "quarantined" | "rejected"; scan: string };
      scanner: FileScanner;
    }> = [
      {
        expected: { availability: "quarantined", scan: "error" },
        scanner: {
          async scan() {
            throw new Error("scanner transport unavailable");
          },
        },
      },
      {
        expected: { availability: "rejected", scan: "infected" },
        scanner: {
          async scan() {
            return { state: "infected", code: "EICAR" };
          },
        },
      },
    ];

    for (const { expected, scanner } of vectors) {
      const service = await fileServiceFor(
        fixture,
        actor,
        store,
        "owner",
        scanner,
      );
      const created = await service.createUploadSession({
        byteSize: body.byteLength,
        checksumSha256: checksum,
        claimedMediaType: "text/plain",
        originalName: `scanner-${expected.scan}.txt`,
        purpose: "EVIDENCE",
      });
      store.objects.set(
        `${actor.workspaceId}:${created.session.objectKey}`,
        body,
      );

      const completed = await service.completeUpload(created.session.id);
      expect(completed.file).toMatchObject({
        quarantineState: expected.availability,
        scanState: expected.scan,
      });
      await expect(
        service.createDownload(completed.file.id),
      ).rejects.toMatchObject({
        extensions: { code: "PRECONDITION_FAILED" },
      });
      expect(
        store.objects.has(`${actor.workspaceId}:${created.session.objectKey}`),
      ).toBe(expected.availability !== "rejected");
    }
  });

  it("archives an authorized file with optimistic versioning and enqueues durable cleanup", async () => {
    const actor = await fixture.createActor("owner");
    const service = await fileServiceFor(fixture, actor, store);
    const body = new TextEncoder().encode("archive evidence");
    const created = await service.createUploadSession({
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      claimedMediaType: "text/plain",
      originalName: "archive.txt",
      purpose: "EVIDENCE",
    });
    store.objects.set(
      `${actor.workspaceId}:${created.session.objectKey}`,
      body,
    );
    const completed = await service.completeUpload(created.session.id);

    const result = await service.archiveFile(
      completed.file.id,
      completed.file.version,
    );
    expect(result.file).toMatchObject({
      id: completed.file.id,
      deletedAt: expect.any(Date),
      version: completed.file.version + 1,
    });
    await expect(service.get(completed.file.id)).resolves.toBeNull();
    const idempotencyKey = archivedFileCleanupIdempotencyKey({
      encryptionKey: "31".repeat(32),
      workspaceId: actor.workspaceId,
      fileId: completed.file.id,
    });
    const [cleanup] = await fixture.database
      .select({
        encryptedPayload: jobs.encryptedPayload,
        idempotencyKey: jobs.idempotencyKey,
        kind: jobs.kind,
        payloadHash: jobs.payloadHash,
        state: jobs.state,
      })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, idempotencyKey));
    expect(cleanup).toMatchObject({
      idempotencyKey,
      kind: "file_cleanup",
      state: "queued",
    });
    expect(
      decodeJobPayload({
        encryptedPayload: cleanup!.encryptedPayload,
        key: "31".repeat(32),
        kind: "file_cleanup",
        payloadHash: cleanup!.payloadHash,
      }),
    ).toEqual({ kind: "file_cleanup", fileId: completed.file.id });
  });

  it("does not archive on a stale version or through another workspace", async () => {
    const actor = await fixture.createActor("owner");
    const service = await fileServiceFor(fixture, actor, store);
    const fileId = newId();
    await fixture.database.insert(files).values({
      id: fileId,
      workspaceId: actor.workspaceId,
      storageProvider: "minio",
      storageBucket: "private",
      storageKey: `uploads/${fileId}/${newId()}`,
      originalName: "stale.txt",
      byteSize: 1,
      checksum: `sha256:${"aa".repeat(32)}`,
      uploadedBy: actor.userId,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    const other = await fixture.createActor("owner");
    const otherService = await fileServiceFor(fixture, other, store);

    await expect(service.archiveFile(fileId, 2)).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    await expect(otherService.archiveFile(fileId, 1)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });

  it("allows an API key with file:delete and denies ungranted or non-visible archival", async () => {
    const actor = await fixture.createActor("owner");
    const allowedKey = await fixture.provisionKey(actor, { file: ["delete"] });
    const deniedKey = await fixture.provisionKey(actor, { file: ["read"] });
    const createFile = async (sensitivity: "internal" | "restricted") => {
      const id = newId();
      await fixture.database.insert(files).values({
        id,
        workspaceId: actor.workspaceId,
        storageProvider: "minio",
        storageBucket: "private",
        storageKey: `uploads/${id}/${newId()}`,
        originalName: `${sensitivity}.txt`,
        byteSize: 1,
        checksum: `sha256:${"bb".repeat(32)}`,
        sensitivity,
        uploadedBy: actor.userId,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      return id;
    };
    const visibleFileId = await createFile("internal");
    const protectedFileId = await createFile("restricted");
    const allowed = await apiKeyFileServiceFor({
      fixture,
      keyId: allowedKey.id,
      permissions: ["file:delete"],
      store,
      workspaceId: actor.workspaceId,
    });
    const denied = await apiKeyFileServiceFor({
      fixture,
      keyId: deniedKey.id,
      permissions: ["file:read"],
      store,
      workspaceId: actor.workspaceId,
    });

    await expect(allowed.archiveFile(visibleFileId, 1)).resolves.toMatchObject({
      file: { id: visibleFileId, deletedAt: expect.any(Date) },
    });
    await expect(denied.archiveFile(protectedFileId, 1)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    await expect(allowed.archiveFile(protectedFileId, 1)).rejects.toMatchObject(
      { extensions: { code: "NOT_FOUND" } },
    );
  });

  it("serializes concurrent actor and workspace pending-upload caps", async () => {
    const owner = await fixture.createActor("owner");
    const actorService = await fileServiceFor(fixture, owner, store);
    const body = new TextEncoder().encode("x");
    const request = {
      byteSize: body.byteLength,
      checksumSha256: createHash("sha256").update(body).digest("hex"),
      claimedMediaType: "text/plain",
      originalName: "cap.txt",
      purpose: "EVIDENCE" as const,
    };
    const actorResults = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        actorService.createUploadSession(request),
      ),
    );
    expect(
      actorResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(5);
    expect(
      actorResults.filter(
        (result) =>
          result.status === "rejected" &&
          (result.reason as { extensions?: { code?: string } }).extensions
            ?.code === "RATE_LIMITED",
      ),
    ).toHaveLength(1);

    await fixture.reset();
    const workspaceOwner = await fixture.createActor("owner");
    const firstMember = await fixture.createWorkspaceMember(
      workspaceOwner,
      "contributor",
    );
    const secondMember = await fixture.createWorkspaceMember(
      workspaceOwner,
      "contributor",
    );
    const now = new Date();
    await fixture.database.insert(uploadSessions).values(
      Array.from({ length: 99 }, (_, index) => {
        const id = newId();
        return {
          id,
          workspaceId: workspaceOwner.workspaceId,
          actorId: workspaceOwner.userId,
          intendedPurpose: "EVIDENCE",
          originalName: `seed-${index}.txt`,
          maxBytes: 1,
          expectedChecksum: `sha256:${"11".repeat(32)}`,
          expectedMediaType: "text/plain",
          objectKey: `uploads/${id}/${newId()}`,
          state: "pending",
          expiresAt: new Date(now.getTime() + 300_000),
          createdBy: workspaceOwner.userId,
          updatedBy: workspaceOwner.userId,
        };
      }),
    );
    const [firstService, secondService] = await Promise.all([
      fileServiceFor(fixture, firstMember, store),
      fileServiceFor(fixture, secondMember, store),
    ]);
    const workspaceResults = await Promise.allSettled([
      firstService.createUploadSession(request),
      secondService.createUploadSession(request),
    ]);
    expect(
      workspaceResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      workspaceResults.filter(
        (result) =>
          result.status === "rejected" &&
          (result.reason as { extensions?: { code?: string } }).extensions
            ?.code === "RATE_LIMITED",
      ),
    ).toHaveLength(1);
  });

  it("exposes only the safe GraphQL upload contract and denies API-key ingestion", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const actor = await graphqlFixture.createActor("owner");
      const body = new TextEncoder().encode("safe evidence");
      const digest = createHash("sha256").update(body).digest("hex");
      const created = await graphqlFixture.execute<{
        createUploadSession?: {
          session: { id: string; state: string; expiresAt: string };
          grant: {
            method: string;
            url: string;
            headers: Record<string, string>;
          };
        };
      }>({
        jar: actor.jar,
        query: /* GraphQL */ `
          mutation CreateUpload($input: CreateUploadSessionInput!) {
            createUploadSession(input: $input) {
              session {
                id
                state
                expiresAt
              }
              grant {
                method
                url
                headers
              }
              issues {
                code
                message
                path
              }
            }
          }
        `,
        variables: {
          input: {
            byteSize: body.byteLength,
            checksumSha256: digest,
            claimedMediaType: "text/plain",
            originalName: "evidence.txt",
            purpose: "EVIDENCE",
          },
        },
      });
      expect(created.body?.errors).toBeUndefined();
      expect(created.body?.data?.createUploadSession).toMatchObject({
        session: { state: "PENDING" },
        grant: { method: "PUT" },
      });
      const storedInput = graphqlStore.uploadInputs.at(-1);
      if (!storedInput) throw new Error("upload input was not captured");
      graphqlStore.objects.set(
        `${storedInput.workspaceId}:${storedInput.key}`,
        body,
      );
      const sessionId = created.body?.data?.createUploadSession?.session.id;
      const completed = await graphqlFixture.execute<{
        completeUpload?: {
          file: { id: string; availability: string; scanState: string };
        };
      }>({
        jar: actor.jar,
        query: /* GraphQL */ `
          mutation CompleteUpload($id: UUID!) {
            completeUpload(uploadSessionId: $id) {
              session {
                id
                state
              }
              file {
                id
                originalName
                byteSize
                availability
                scanState
                sensitivity
              }
              issues {
                code
                message
                path
              }
            }
          }
        `,
        variables: { id: sessionId },
      });
      expect(completed.body?.errors).toBeUndefined();
      expect(completed.body?.data?.completeUpload?.file).toMatchObject({
        availability: "AVAILABLE",
        scanState: "NOT_REQUIRED",
      });

      const apiKey = await graphqlFixture.provisionKey(actor, {
        file: ["create", "read"],
      });
      const callsBefore = graphqlStore.uploadCalls;
      const denied = await graphqlFixture.execute({
        apiKey: apiKey.key,
        query: /* GraphQL */ `
          mutation CreateUpload($input: CreateUploadSessionInput!) {
            createUploadSession(input: $input) {
              session {
                id
              }
            }
          }
        `,
        variables: {
          input: {
            byteSize: body.byteLength,
            checksumSha256: digest,
            claimedMediaType: "text/plain",
            originalName: "evidence.txt",
            purpose: "EVIDENCE",
          },
        },
      });
      expect(denied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      expect(graphqlStore.uploadCalls).toBe(callsBefore);
    } finally {
      await graphqlFixture.close();
    }
  });

  it("accepts exactly 4 MiB and rejects 4 MiB plus one in Vercel mode without side effects", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "vercel",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "r2",
      },
    });
    try {
      await graphqlFixture.reset();
      const actor = await graphqlFixture.createActor("owner");
      const create = (byteSize: number) =>
        graphqlFixture.execute({
          jar: actor.jar,
          query: /* GraphQL */ `
            mutation CreateUpload($input: CreateUploadSessionInput!) {
              createUploadSession(input: $input) {
                session {
                  id
                  state
                }
                grant {
                  method
                  contentLength
                }
              }
            }
          `,
          variables: {
            input: {
              byteSize,
              checksumSha256: "ab".repeat(32),
              claimedMediaType: "text/plain",
              originalName: "hosted-evidence.txt",
              purpose: "EVIDENCE",
            },
          },
        });

      const accepted = await create(4 * 1024 * 1024);
      expect(accepted.body?.errors).toBeUndefined();
      expect(accepted.body?.data?.createUploadSession).toMatchObject({
        session: { state: "PENDING" },
        grant: { method: "PUT", contentLength: 4 * 1024 * 1024 },
      });

      const sideEffects = async () => {
        const [sessions, queuedJobs, audits] = await Promise.all([
          graphqlFixture.database
            .select({ id: uploadSessions.id })
            .from(uploadSessions)
            .where(eq(uploadSessions.workspaceId, actor.workspaceId)),
          graphqlFixture.database
            .select({ id: jobs.id })
            .from(jobs)
            .where(eq(jobs.workspaceId, actor.workspaceId)),
          graphqlFixture.database
            .select({ id: auditEvents.id })
            .from(auditEvents)
            .where(eq(auditEvents.workspaceId, actor.workspaceId)),
        ]);
        return {
          auditCount: audits.length,
          grantCount: graphqlStore.uploadCalls,
          jobCount: queuedJobs.length,
          sessionCount: sessions.length,
        };
      };
      const before = await sideEffects();
      const rejected = await create(4 * 1024 * 1024 + 1);
      expect(rejected.body?.errors?.[0]).toMatchObject({
        extensions: { code: "VALIDATION_FAILED" },
        message: "The upload request is invalid.",
      });
      expect(JSON.stringify(rejected.body)).not.toMatch(
        /vercel|provider|proxy|function body/iu,
      );
      await expect(sideEffects()).resolves.toEqual(before);
    } finally {
      await graphqlFixture.close();
    }
  });

  it("retains the larger purpose-specific upload limits in Docker mode", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const actor = await graphqlFixture.createActor("owner");
      for (const [purpose, byteSize, originalName, claimedMediaType] of [
        ["EVIDENCE", 50 * 1024 * 1024, "evidence.txt", "text/plain"],
        ["CSV_IMPORT", 25 * 1024 * 1024, "people.csv", "text/csv"],
        ["JSON_IMPORT", 10 * 1024 * 1024, "people.json", "application/json"],
      ] as const) {
        const created = await graphqlFixture.execute({
          jar: actor.jar,
          query: /* GraphQL */ `
            mutation CreateUpload($input: CreateUploadSessionInput!) {
              createUploadSession(input: $input) {
                session {
                  id
                  state
                }
                grant {
                  method
                  contentLength
                }
              }
            }
          `,
          variables: {
            input: {
              byteSize,
              checksumSha256: "cd".repeat(32),
              claimedMediaType,
              originalName,
              purpose,
            },
          },
        });
        expect(created.body?.errors).toBeUndefined();
        expect(created.body?.data?.createUploadSession).toMatchObject({
          session: { state: "PENDING" },
          grant: { method: "PUT", contentLength: byteSize },
        });
      }
      expect(graphqlStore.uploadCalls).toBe(3);
    } finally {
      await graphqlFixture.close();
    }
  });

  it("exposes owner-scoped upload recovery and archive operations through the real GraphQL context", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const peer = await graphqlFixture.createWorkspaceMember(
        owner,
        "contributor",
      );
      const otherOwner = await graphqlFixture.createActor("owner");
      const body = new TextEncoder().encode("recover me");
      const created = await graphqlFixture.execute<{
        createUploadSession?: { session: { id: string } };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation CreateUpload($input: CreateUploadSessionInput!) {
            createUploadSession(input: $input) {
              session {
                id
              }
            }
          }
        `,
        variables: {
          input: {
            byteSize: body.byteLength,
            checksumSha256: createHash("sha256").update(body).digest("hex"),
            claimedMediaType: "text/plain",
            originalName: "recover.txt",
            purpose: "EVIDENCE",
          },
        },
      });
      const sessionId = created.body?.data?.createUploadSession?.session.id;

      const pending = await graphqlFixture.execute<{
        uploadSessions?: { nodes: Array<{ id: string; originalName: string }> };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          query PendingWorkspaceUploads {
            uploadSessions(first: 20, states: [PENDING]) {
              nodes {
                id
                originalName
                byteSize
                state
                expiresAt
                checksumSha256
              }
            }
          }
        `,
      });
      expect(pending.body?.errors).toBeUndefined();
      expect(pending.body?.data?.uploadSessions?.nodes).toEqual([
        expect.objectContaining({ id: sessionId, originalName: "recover.txt" }),
      ]);

      const regranted = await graphqlFixture.execute<{
        regrantUploadSession?: {
          session: { id: string; state: string };
          grant: { method: string; contentLength: number };
        };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation RegrantWorkspaceUpload($id: UUID!) {
            regrantUploadSession(uploadSessionId: $id) {
              session {
                id
                state
              }
              grant {
                method
                url
                headers
                contentLength
              }
            }
          }
        `,
        variables: { id: sessionId },
      });
      expect(regranted.body?.errors).toBeUndefined();
      expect(regranted.body?.data?.regrantUploadSession).toMatchObject({
        session: { id: sessionId, state: "PENDING" },
        grant: { method: "PUT", contentLength: body.byteLength },
      });

      for (const jar of [peer.jar, otherOwner.jar]) {
        const hidden = await graphqlFixture.execute({
          jar,
          query: /* GraphQL */ `
            mutation RegrantWorkspaceUpload($id: UUID!) {
              regrantUploadSession(uploadSessionId: $id) {
                session {
                  id
                  state
                }
                grant {
                  method
                  url
                  headers
                  contentLength
                }
              }
            }
          `,
          variables: { id: sessionId },
        });
        expect(hidden.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
        expect(JSON.stringify(hidden.body)).not.toContain(
          created.body?.data?.createUploadSession?.session.id ?? "missing",
        );
      }

      const cancelled = await graphqlFixture.execute<{
        cancelUploadSession?: { session: { id: string; state: string } };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation CancelWorkspaceUpload($id: UUID!) {
            cancelUploadSession(uploadSessionId: $id) {
              session {
                id
                state
              }
            }
          }
        `,
        variables: { id: sessionId },
      });
      expect(cancelled.body?.errors).toBeUndefined();
      expect(cancelled.body?.data?.cancelUploadSession?.session).toEqual({
        id: sessionId,
        state: "CLEANUP_PENDING",
      });
      const [cleanup] = await graphqlFixture.database
        .select({ scheduledAt: jobs.scheduledAt })
        .from(jobs)
        .where(eq(jobs.kind, "file_cleanup"));
      expect(cleanup?.scheduledAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 1_000,
      );
      const [audit] = await graphqlFixture.database
        .select({ redactedDiff: auditEvents.redactedDiff })
        .from(auditEvents)
        .where(eq(auditEvents.action, "file.upload_cancelled"));
      expect(audit?.redactedDiff).toMatchObject({
        metadata: { state: "cleanup_pending" },
      });
      expect(JSON.stringify(audit)).not.toMatch(/uploads\/|private|minio/iu);
    } finally {
      await graphqlFixture.close();
    }
  });

  it("paginates owned upload sessions stably without disclosing peer or foreign sessions", async () => {
    const graphqlFixture = new ResearchFixture();
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const peer = await graphqlFixture.createWorkspaceMember(
        owner,
        "contributor",
      );
      const foreign = await graphqlFixture.createActor("owner");
      const newest = new Date("2026-08-04T13:00:00.000Z");
      const ownerRows = [
        { id: newId(), createdAt: newest },
        { id: newId(), createdAt: newest },
        { id: newId(), createdAt: new Date(newest.getTime() - 1_000) },
        { id: newId(), createdAt: new Date(newest.getTime() - 2_000) },
      ].sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      );
      const peerId = newId();
      const foreignId = newId();
      await graphqlFixture.database.insert(uploadSessions).values(
        [
          ...ownerRows.map((row) => ({
            ...row,
            workspaceId: owner.workspaceId,
            actorId: owner.userId,
            originalName: `${row.id}.txt`,
            objectKey: `uploads/${row.id}/${newId()}`,
            updatedAt: row.createdAt,
            createdBy: owner.userId,
            updatedBy: owner.userId,
          })),
          {
            id: peerId,
            workspaceId: owner.workspaceId,
            actorId: peer.userId,
            originalName: "peer.txt",
            objectKey: `uploads/${peerId}/${newId()}`,
            createdAt: new Date(newest.getTime() + 1_000),
            updatedAt: new Date(newest.getTime() + 1_000),
            createdBy: peer.userId,
            updatedBy: peer.userId,
          },
          {
            id: foreignId,
            workspaceId: foreign.workspaceId,
            actorId: foreign.userId,
            originalName: "foreign.txt",
            objectKey: `uploads/${foreignId}/${newId()}`,
            createdAt: new Date(newest.getTime() + 2_000),
            updatedAt: new Date(newest.getTime() + 2_000),
            createdBy: foreign.userId,
            updatedBy: foreign.userId,
          },
        ].map((row) => ({
          intendedPurpose: "EVIDENCE",
          maxBytes: 1,
          expectedChecksum: `sha256:${"35".repeat(32)}`,
          expectedMediaType: "text/plain",
          state: "pending",
          expiresAt: new Date(newest.getTime() + 60_000),
          ...row,
        })),
      );
      const query = /* GraphQL */ `
        query UploadPages($first: Int!, $after: String) {
          uploadSessions(first: $first, after: $after, states: [PENDING]) {
            nodes {
              id
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      `;
      const first = await graphqlFixture.execute<{
        uploadSessions: {
          nodes: Array<{ id: string }>;
          pageInfo: { endCursor: string; hasNextPage: boolean };
        };
      }>({ jar: owner.jar, query, variables: { first: 2 } });
      const second = await graphqlFixture.execute<{
        uploadSessions: {
          nodes: Array<{ id: string }>;
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      }>({
        jar: owner.jar,
        query,
        variables: {
          first: 2,
          after: first.body?.data?.uploadSessions.pageInfo.endCursor,
        },
      });
      expect(first.body?.errors).toBeUndefined();
      expect(second.body?.errors).toBeUndefined();
      expect([
        ...(first.body?.data?.uploadSessions.nodes ?? []),
        ...(second.body?.data?.uploadSessions.nodes ?? []),
      ]).toEqual(ownerRows.map((row) => ({ id: row.id })));
      expect(first.body?.data?.uploadSessions.pageInfo.hasNextPage).toBe(true);
      expect(second.body?.data?.uploadSessions.pageInfo.hasNextPage).toBe(
        false,
      );

      for (const [jar, visibleId] of [
        [peer.jar, peerId],
        [foreign.jar, foreignId],
      ] as const) {
        const isolated = await graphqlFixture.execute<{
          uploadSessions: { nodes: Array<{ id: string }> };
        }>({ jar, query, variables: { first: 20 } });
        expect(isolated.body?.errors).toBeUndefined();
        expect(isolated.body?.data?.uploadSessions.nodes).toEqual([
          { id: visibleId },
        ]);
      }
    } finally {
      await graphqlFixture.close();
    }
  });

  it("rejects regrant for expired, rejected, and completed sessions without disclosing storage coordinates", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const fileId = newId();
      await graphqlFixture.database.insert(files).values({
        id: fileId,
        workspaceId: owner.workspaceId,
        storageProvider: "minio",
        storageBucket: "private",
        storageKey: `uploads/${fileId}/${newId()}`,
        originalName: "completed.txt",
        byteSize: 1,
        checksum: `sha256:${"31".repeat(32)}`,
        uploadedBy: owner.userId,
        createdBy: owner.userId,
        updatedBy: owner.userId,
      });
      const now = new Date();
      const seeded = [
        { state: "expired", expiresAt: new Date(now.getTime() - 1_000) },
        { state: "rejected", expiresAt: new Date(now.getTime() + 60_000) },
        {
          state: "completed",
          expiresAt: new Date(now.getTime() + 60_000),
          completedAt: now,
          fileId,
        },
      ] as const;
      const ids = seeded.map(() => newId());
      await graphqlFixture.database.insert(uploadSessions).values(
        seeded.map((session, index) => ({
          id: ids[index]!,
          workspaceId: owner.workspaceId,
          actorId: owner.userId,
          intendedPurpose: "EVIDENCE",
          originalName: `${session.state}.txt`,
          maxBytes: 1,
          expectedChecksum: `sha256:${"31".repeat(32)}`,
          expectedMediaType: "text/plain",
          objectKey: `uploads/${ids[index]}/${newId()}`,
          state: session.state,
          expiresAt: session.expiresAt,
          completedAt: "completedAt" in session ? session.completedAt : null,
          fileId: "fileId" in session ? session.fileId : null,
          failureCode:
            session.state === "completed" ? null : session.state.toUpperCase(),
          createdBy: owner.userId,
          updatedBy: owner.userId,
        })),
      );

      for (const id of ids) {
        const result = await graphqlFixture.execute({
          jar: owner.jar,
          query: /* GraphQL */ `
            mutation RegrantWorkspaceUpload($id: UUID!) {
              regrantUploadSession(uploadSessionId: $id) {
                session {
                  id
                  state
                }
                grant {
                  method
                  url
                  headers
                  contentLength
                }
              }
            }
          `,
          variables: { id },
        });
        expect(result.body?.errors?.[0]?.extensions?.code).toBe("CONFLICT");
        expect(JSON.stringify(result.body)).not.toMatch(
          /uploads\/|private|minio/iu,
        );
      }

      const apiKey = await graphqlFixture.provisionKey(owner, {
        file: ["create"],
      });
      for (const operation of ["regrantUploadSession", "cancelUploadSession"]) {
        const denied = await graphqlFixture.execute({
          apiKey: apiKey.key,
          query: `mutation SessionOperation($id: UUID!) { ${operation}(uploadSessionId: $id) { session { id } } }`,
          variables: { id: ids[0] },
        });
        expect(denied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      }
    } finally {
      await graphqlFixture.close();
    }
  });

  it("rejects a Docker-sized pending session when regranted in Vercel mode without signing", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "vercel",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "r2",
      },
    });
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const uploadSessionId = newId();
      await graphqlFixture.database.insert(uploadSessions).values({
        id: uploadSessionId,
        workspaceId: owner.workspaceId,
        actorId: owner.userId,
        intendedPurpose: "EVIDENCE",
        originalName: "legacy-docker-sized.txt",
        maxBytes: 5 * 1024 * 1024,
        expectedChecksum: "31".repeat(32),
        expectedMediaType: "text/plain",
        objectKey: `uploads/${uploadSessionId}/${newId()}`,
        state: "pending",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        createdBy: owner.userId,
        updatedBy: owner.userId,
      });
      const callsBefore = graphqlStore.uploadCalls;

      const result = await graphqlFixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation Regrant($id: UUID!) {
            regrantUploadSession(uploadSessionId: $id) {
              session {
                id
                state
              }
              grant {
                method
                url
                headers
              }
            }
          }
        `,
        variables: { id: uploadSessionId },
      });

      expect(result.body?.errors?.[0]?.extensions?.code).toBe("CONFLICT");
      expect(graphqlStore.uploadCalls).toBe(callsBefore);
      expect(JSON.stringify(result.body)).not.toMatch(/vercel|r2|private/iu);
    } finally {
      await graphqlFixture.close();
    }
  });

  it("serializes cancellation against completion", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const body = new TextEncoder().encode("serialize me");
      const created = await graphqlFixture.execute<{
        createUploadSession?: { session: { id: string } };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation CreateUpload($input: CreateUploadSessionInput!) {
            createUploadSession(input: $input) {
              session {
                id
              }
            }
          }
        `,
        variables: {
          input: {
            originalName: "serialize.txt",
            claimedMediaType: "text/plain",
            byteSize: body.byteLength,
            checksumSha256: createHash("sha256").update(body).digest("hex"),
            purpose: "EVIDENCE",
          },
        },
      });
      const sessionId = created.body?.data?.createUploadSession?.session.id;
      const upload = graphqlStore.uploadInputs.at(-1)!;
      graphqlStore.objects.set(`${upload.workspaceId}:${upload.key}`, body);
      const [complete, cancel] = await Promise.all([
        graphqlFixture.execute({
          jar: owner.jar,
          query: /* GraphQL */ `
            mutation Complete($id: UUID!) {
              completeUpload(uploadSessionId: $id) {
                session {
                  id
                  state
                }
                file {
                  id
                }
              }
            }
          `,
          variables: { id: sessionId },
        }),
        graphqlFixture.execute({
          jar: owner.jar,
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
          variables: { id: sessionId },
        }),
      ]);
      const successCount = [complete, cancel].filter(
        (result) => !result.body?.errors,
      ).length;
      expect(successCount).toBe(1);
      expect(
        [complete, cancel]
          .flatMap((result) => result.body?.errors ?? [])
          .map((error) => error.extensions?.code),
      ).toEqual(["CONFLICT"]);
      const [session] = await graphqlFixture.database
        .select({ state: uploadSessions.state })
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId!));
      expect(["completed", "cleanup_pending"]).toContain(session?.state);
    } finally {
      await graphqlFixture.close();
    }
  });

  it("revalidates live membership before cancellation", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const body = new TextEncoder().encode("authority");
      const created = await graphqlFixture.execute<{
        createUploadSession?: { session: { id: string } };
      }>({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation CreateUpload($input: CreateUploadSessionInput!) {
            createUploadSession(input: $input) {
              session {
                id
              }
            }
          }
        `,
        variables: {
          input: {
            originalName: "authority.txt",
            claimedMediaType: "text/plain",
            byteSize: body.byteLength,
            checksumSha256: createHash("sha256").update(body).digest("hex"),
            purpose: "EVIDENCE",
          },
        },
      });
      const sessionId = created.body?.data?.createUploadSession?.session.id;
      let request: ReturnType<typeof graphqlFixture.execute> | undefined;
      await graphqlFixture.connection.begin(async (transaction) => {
        await transaction`select id from members where id = ${owner.memberId} for update`;
        request = graphqlFixture.execute({
          jar: owner.jar,
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
          variables: { id: sessionId },
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        await transaction`update members set role = 'viewer' where id = ${owner.memberId}`;
      });
      if (!request) throw new Error("Cancellation request did not start");
      const denied = await request;
      expect(denied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      const [session] = await graphqlFixture.database
        .select({ state: uploadSessions.state })
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId!));
      expect(session?.state).toBe("pending");
    } finally {
      await graphqlFixture.close();
    }
  });

  it("serializes regrant signing with cancellation in both commit orders", async () => {
    const actor = await fixture.createActor("owner");
    const service = await fileServiceFor(fixture, actor, store);
    const createPending = () =>
      service.createUploadSession({
        originalName: "regrant-race.txt",
        claimedMediaType: "text/plain",
        byteSize: 4,
        checksumSha256: createHash("sha256").update("safe").digest("hex"),
        purpose: "EVIDENCE",
      });

    const grantFirst = await createPending();
    const signingEntered = deferred();
    const releaseSigning = deferred();
    store.beforeCreateUpload = async () => {
      signingEntered.resolve();
      await releaseSigning.promise;
    };
    const regrant = service.regrantUploadSession(grantFirst.session.id);
    await signingEntered.promise;
    let cancelSettled = false;
    const cancelAfterGrant = service
      .cancelUploadSession(grantFirst.session.id)
      .finally(() => {
        cancelSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(cancelSettled).toBe(false);
    releaseSigning.resolve();
    await expect(regrant).resolves.toMatchObject({
      session: { state: "pending" },
      grant: { method: "PUT" },
    });
    await expect(cancelAfterGrant).resolves.toMatchObject({
      session: { state: "cleanup_pending" },
    });

    store.beforeCreateUpload = undefined;
    const cancelFirst = await createPending();
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    store.beforeDelete = async () => {
      deleteEntered.resolve();
      await releaseDelete.promise;
    };
    const cancellation = service.cancelUploadSession(cancelFirst.session.id);
    await deleteEntered.promise;
    await expect(
      service.regrantUploadSession(cancelFirst.session.id),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    releaseDelete.resolve();
    await expect(cancellation).resolves.toMatchObject({
      session: { state: "cleanup_pending" },
    });
  });

  it("serializes regrant signing with live permission revocation in both commit orders", async () => {
    const owner = await fixture.createActor("owner");
    const contributor = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const service = await fileServiceFor(
      fixture,
      contributor,
      store,
      "contributor",
    );
    const createPending = () =>
      service.createUploadSession({
        originalName: "authority-race.txt",
        claimedMediaType: "text/plain",
        byteSize: 4,
        checksumSha256: createHash("sha256").update("safe").digest("hex"),
        purpose: "EVIDENCE",
      });

    const grantFirst = await createPending();
    const signingEntered = deferred();
    const releaseSigning = deferred();
    store.beforeCreateUpload = async () => {
      signingEntered.resolve();
      await releaseSigning.promise;
    };
    const regrant = service.regrantUploadSession(grantFirst.session.id);
    await signingEntered.promise;
    let revocationSettled = false;
    const revocation = fixture.connection
      .begin(async (transaction) => {
        await transaction`update members set role = 'viewer' where id = ${contributor.memberId}`;
      })
      .finally(() => {
        revocationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(revocationSettled).toBe(false);
    releaseSigning.resolve();
    await expect(regrant).resolves.toMatchObject({ grant: { method: "PUT" } });
    await revocation;

    const contributorTwo = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const serviceTwo = await fileServiceFor(
      fixture,
      contributorTwo,
      store,
      "contributor",
    );
    store.beforeCreateUpload = undefined;
    const revokeFirst = await serviceTwo.createUploadSession({
      originalName: "revoked-first.txt",
      claimedMediaType: "text/plain",
      byteSize: 4,
      checksumSha256: createHash("sha256").update("safe").digest("hex"),
      purpose: "EVIDENCE",
    });
    const callsBefore = store.uploadCalls;
    let pendingRegrant:
      ReturnType<typeof serviceTwo.regrantUploadSession> | undefined;
    await fixture.connection.begin(async (transaction) => {
      await transaction`select id from members where id = ${contributorTwo.memberId} for update`;
      pendingRegrant = serviceTwo.regrantUploadSession(revokeFirst.session.id);
      await new Promise((resolve) => setTimeout(resolve, 75));
      await transaction`update members set role = 'viewer' where id = ${contributorTwo.memberId}`;
    });
    if (!pendingRegrant) throw new Error("Regrant request did not start");
    await expect(pendingRegrant).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    expect(store.uploadCalls).toBe(callsBefore);
  });

  it.each(["grant", "policy"] as const)(
    "rechecks and locks restricted-file %s authority across both archive/revocation orders",
    async (revocationTarget) => {
      async function seedAuthorizedArchive(name: string) {
        const actor = await fixture.createActor("owner");
        const service = await fileServiceFor(fixture, actor, store);
        const fileId = newId();
        const policyId = newId();
        const grantId = newId();
        await fixture.database.insert(files).values({
          id: fileId,
          workspaceId: actor.workspaceId,
          storageProvider: "minio",
          storageBucket: "private",
          storageKey: `uploads/${fileId}/${newId()}`,
          originalName: name,
          byteSize: 1,
          checksum: `sha256:${"47".repeat(32)}`,
          sensitivity: "restricted",
          uploadedBy: actor.userId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
        await fixture.database.insert(accessPolicies).values({
          id: policyId,
          workspaceId: actor.workspaceId,
          name: `${name}-${policyId}`,
          sensitivityCeiling: "restricted",
          resourceKinds: ["file"],
          state: "active",
          createdBy: actor.principalId,
          updatedBy: actor.principalId,
        });
        await fixture.database.insert(resourceGrants).values({
          id: grantId,
          workspaceId: actor.workspaceId,
          policyId,
          memberId: actor.memberId,
          resourceId: fileId,
          resourceKind: "file",
          state: "active",
          createdBy: actor.principalId,
          updatedBy: actor.principalId,
        });
        return { actor, fileId, grantId, policyId, service };
      }

      const revokeFirst = await seedAuthorizedArchive(
        `${revocationTarget}-revoke-first.txt`,
      );
      let deniedArchive:
        ReturnType<typeof revokeFirst.service.archiveFile> | undefined;
      await fixture.connection.begin(async (transaction) => {
        if (revocationTarget === "grant") {
          await transaction`select id from resource_grants where id = ${revokeFirst.grantId}::uuid for update`;
        } else {
          await transaction`select id from access_policies where id = ${revokeFirst.policyId}::uuid for update`;
        }
        deniedArchive = revokeFirst.service.archiveFile(revokeFirst.fileId, 1);
        await new Promise((resolve) => setTimeout(resolve, 75));
        if (revocationTarget === "grant") {
          await transaction`update resource_grants set state = 'inactive' where id = ${revokeFirst.grantId}::uuid`;
        } else {
          await transaction`update access_policies set state = 'disabled' where id = ${revokeFirst.policyId}::uuid`;
        }
      });
      if (!deniedArchive) throw new Error("Archive request did not start");
      await expect(deniedArchive).rejects.toMatchObject({
        extensions: { code: "NOT_FOUND" },
      });

      const archiveFirst = await seedAuthorizedArchive(
        `${revocationTarget}-archive-first.txt`,
      );
      let acceptedArchive:
        ReturnType<typeof archiveFirst.service.archiveFile> | undefined;
      let revocation: Promise<unknown> | undefined;
      await fixture.connection.begin(async (auditLocker) => {
        await auditLocker`lock table audit_events in access exclusive mode`;
        acceptedArchive = archiveFirst.service.archiveFile(
          archiveFirst.fileId,
          1,
        );
        await waitForDatabaseLock(fixture, "audit_events");
        let revocationSettled = false;
        revocation = fixture.connection
          .begin(async (transaction) => {
            if (revocationTarget === "grant") {
              await transaction`update resource_grants set state = 'inactive' where id = ${archiveFirst.grantId}::uuid`;
            } else {
              await transaction`update access_policies set state = 'disabled' where id = ${archiveFirst.policyId}::uuid`;
            }
          })
          .finally(() => {
            revocationSettled = true;
          });
        await waitForDatabaseLock(
          fixture,
          revocationTarget === "grant" ? "resource_grants" : "access_policies",
        );
        expect(revocationSettled).toBe(false);
      });
      if (!acceptedArchive || !revocation) {
        throw new Error("Archive-first race did not start");
      }
      await expect(acceptedArchive).resolves.toMatchObject({
        file: { id: archiveFirst.fileId, deletedAt: expect.any(Date) },
      });
      await revocation;
    },
  );

  it("exposes safe variants, archives through user and API-key GraphQL, and denies archived downloads", async () => {
    const graphqlStore = new MemoryObjectStore();
    const graphqlFixture = new ResearchFixture({
      fileRuntime: {
        deploymentMode: "docker",
        encryptionKey: "31".repeat(32),
        objectStore: graphqlStore,
        storageBucket: "private",
        storageProvider: "minio",
      },
    });
    try {
      await graphqlFixture.reset();
      const owner = await graphqlFixture.createActor("owner");
      const seedFile = async (
        name: string,
        sensitivity: "internal" | "restricted" = "internal",
      ) => {
        const id = newId();
        await graphqlFixture.database.insert(files).values({
          id,
          workspaceId: owner.workspaceId,
          storageProvider: "minio",
          storageBucket: "private",
          storageKey: `uploads/${id}/${newId()}`,
          originalName: name,
          mediaType: "text/plain",
          detectedType: "text/plain",
          byteSize: 8,
          checksum: `sha256:${"42".repeat(32)}`,
          quarantineState: "available",
          scanState: "clean",
          sensitivity,
          uploadedBy: owner.userId,
          createdBy: owner.userId,
          updatedBy: owner.userId,
        });
        return id;
      };
      const userFileId = await seedFile("variant.txt");
      const variantId = newId();
      await graphqlFixture.database.insert(fileVariants).values({
        id: variantId,
        workspaceId: owner.workspaceId,
        parentFileId: userFileId,
        kind: "thumbnail",
        storageProvider: "minio",
        storageBucket: "private",
        storageKey: `variants/${userFileId}/${newId()}`,
        mediaType: "image/webp",
        byteSize: 5,
        checksum: `sha256:${"43".repeat(32)}`,
        generatorVersion: "thumb-v1",
        createdBy: owner.userId,
      });
      const visible = await graphqlFixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          query FileVariants($id: UUID!) {
            file(id: $id) {
              id
              variants {
                id
                kind
                mediaType
                byteSize
                checksum
                generatorVersion
                createdAt
              }
            }
          }
        `,
        variables: { id: userFileId },
      });
      expect(visible.body?.errors).toBeUndefined();
      expect(visible.body?.data).toMatchObject({
        file: {
          variants: [
            {
              id: variantId,
              kind: "thumbnail",
              mediaType: "image/webp",
              byteSize: 5,
              generatorVersion: "thumb-v1",
            },
          ],
        },
      });
      expect(JSON.stringify(visible.body)).not.toMatch(
        /storageKey|storageBucket|storageProvider|variants\/|private|minio/iu,
      );

      const archived = await graphqlFixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation ArchiveWorkspaceFile($id: UUID!, $expectedVersion: Int!) {
            archiveFile(fileId: $id, expectedVersion: $expectedVersion) {
              file {
                id
                version
                archivedAt
                variants {
                  id
                  kind
                  checksum
                }
              }
            }
          }
        `,
        variables: { id: userFileId, expectedVersion: 1 },
      });
      expect(archived.body?.errors).toBeUndefined();
      expect(archived.body?.data).toMatchObject({
        archiveFile: {
          file: {
            id: userFileId,
            version: 2,
            archivedAt: expect.any(String),
            variants: [
              {
                id: variantId,
                kind: "thumbnail",
                checksum: `sha256:${"43".repeat(32)}`,
              },
            ],
          },
        },
      });
      const deniedDownload = await graphqlFixture.execute({
        jar: owner.jar,
        query: /* GraphQL */ `
          mutation Download($id: UUID!) {
            createFileDownload(fileId: $id) {
              grant {
                url
              }
            }
          }
        `,
        variables: { id: userFileId },
      });
      expect(deniedDownload.body?.errors?.[0]?.extensions?.code).toBe(
        "NOT_FOUND",
      );

      const allowedFileId = await seedFile("api-allowed.txt");
      const deniedFileId = await seedFile("api-denied.txt");
      const restrictedFileId = await seedFile("api-hidden.txt", "restricted");
      const allowedKey = await graphqlFixture.provisionKey(owner, {
        file: ["delete"],
      });
      const deniedKey = await graphqlFixture.provisionKey(owner, {
        file: ["read"],
      });
      const archiveMutation = /* GraphQL */ `
        mutation ArchiveWorkspaceFile($id: UUID!, $expectedVersion: Int!) {
          archiveFile(fileId: $id, expectedVersion: $expectedVersion) {
            file {
              id
              version
              archivedAt
            }
          }
        }
      `;
      const apiArchived = await graphqlFixture.execute({
        apiKey: allowedKey.key,
        query: archiveMutation,
        variables: { id: allowedFileId, expectedVersion: 1 },
      });
      expect(apiArchived.body?.errors).toBeUndefined();
      const apiDenied = await graphqlFixture.execute({
        apiKey: deniedKey.key,
        query: archiveMutation,
        variables: { id: deniedFileId, expectedVersion: 1 },
      });
      expect(apiDenied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
      const apiHidden = await graphqlFixture.execute({
        apiKey: allowedKey.key,
        query: archiveMutation,
        variables: { id: restrictedFileId, expectedVersion: 1 },
      });
      expect(apiHidden.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    } finally {
      await graphqlFixture.close();
    }
  });
});
