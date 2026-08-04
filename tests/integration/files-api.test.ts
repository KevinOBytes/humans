// @vitest-environment node

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { sessions } from "@/db/schema/auth";
import { newId } from "@/db/id";
import { files, uploadSessions } from "@/db/schema/files";
import { jobs } from "@/db/schema/operations";
import { workspaceUsage } from "@/db/schema/workspaces";
import type { ObjectStore } from "@/lib/storage/types";
import { createFilesService } from "@/modules/files/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploadInputs: Array<{ workspaceId: string; key: string }> = [];
  uploadCalls = 0;

  async createUpload(input: {
    workspaceId: string;
    key: string;
    bytes: number;
    contentType: string;
    checksumSha256: string;
  }) {
    this.uploadCalls += 1;
    this.uploadInputs.push({ workspaceId: input.workspaceId, key: input.key });
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
    this.objects.delete(`${input.workspaceId}:${input.key}`);
  }
}

async function fileServiceFor(
  fixture: ResearchFixture,
  actor: SessionActor,
  store: MemoryObjectStore,
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
      permissions: new Set(["file:create", "file:delete", "file:read"]),
      requestId: newId(),
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: actor.workspaceId,
    },
    {
      encryptionKey: "31".repeat(32),
      objectStore: store,
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
    const [cleanup] = await fixture.database
      .select({ kind: jobs.kind, state: jobs.state })
      .from(jobs)
      .where(eq(jobs.workspaceId, actor.workspaceId));
    expect(cleanup).toMatchObject({ kind: "file_cleanup", state: "queued" });
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
});
