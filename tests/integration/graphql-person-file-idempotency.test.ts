// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, gt } from "drizzle-orm";

import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { personFileAttachments } from "@/db/schema/people";
import {
  ArchivePersonFileDocument,
  AttachPersonFileDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type Actor = Awaited<ReturnType<ResearchFixture["createActor"]>>;

type Attachment = {
  archivedAt: string | null;
  fileId: string;
  id: string;
  label: string | null;
  personId: string;
  version: number;
};

type AttachResult = {
  attachPersonFile: {
    attachment: Attachment | null;
    code: string | null;
    currentVersion: number | null;
    issues: Array<{ code: string; path: string[] }>;
  };
};

type ArchiveResult = {
  archivePersonFile: {
    attachment: Attachment | null;
    code: string | null;
    currentVersion: number | null;
    issues: Array<{ code: string; path: string[] }>;
  };
};

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

async function createAvailableFile(
  fixture: ResearchFixture,
  actor: Actor,
  suffix = newId(),
): Promise<string> {
  const fileId = newId();
  await fixture.database.insert(files).values({
    id: fileId,
    workspaceId: actor.workspaceId,
    storageProvider: "minio",
    storageBucket: "humans-private",
    storageKey: `person-files/${suffix}`,
    originalName: `${suffix}.txt`,
    mediaType: "text/plain",
    detectedType: "text/plain",
    byteSize: 32,
    checksum: `sha256:${"a".repeat(64)}`,
    quarantineState: "available",
    scanState: "clean",
    ocrState: "not_requested",
    extractionState: "not_requested",
    sensitivity: "internal",
    uploadedBy: actor.userId,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
  return fileId;
}

async function createPerson(
  fixture: ResearchFixture,
  actor: Actor,
  displayName: string,
): Promise<string> {
  const result = await fixture.createPerson(actor, { displayName });
  expect(result.body?.errors).toBeUndefined();
  return required(
    result.body?.data?.createPerson?.person?.id,
    `${displayName} person ID`,
  );
}

async function attach(
  fixture: ResearchFixture,
  actor: Actor,
  input: {
    fileId: string;
    idempotencyKey?: string;
    label?: string;
    personId: string;
  },
) {
  return fixture.execute<AttachResult>({
    jar: actor.jar,
    operationName: "AttachPersonFile",
    query: AttachPersonFileDocument,
    variables: { input },
  });
}

async function archive(
  fixture: ResearchFixture,
  actor: Actor,
  input: { expectedVersion: number; id: string; idempotencyKey?: string },
) {
  return fixture.execute<ArchiveResult>({
    jar: actor.jar,
    operationName: "ArchivePersonFile",
    query: ArchivePersonFileDocument,
    variables: { input },
  });
}

liveDescribe("generated person-file attachment idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("converges concurrent attach calls and rejects changed material and malformed replay references", async () => {
    const owner = await fixture.createActor();
    const personId = await createPerson(fixture, owner, "Attachment subject");
    const fileId = await createAvailableFile(fixture, owner);
    const input = {
      personId,
      fileId,
      label: "Identity document",
      idempotencyKey: "person-file-attach-concurrent-v1",
    };

    const [left, right] = await Promise.all([
      attach(fixture, owner, input),
      attach(fixture, owner, input),
    ]);
    expect(left.body?.errors).toBeUndefined();
    expect(right.body?.errors).toBeUndefined();
    const first = required(
      left.body?.data?.attachPersonFile.attachment,
      "first attachment",
    );
    expect(right.body?.data?.attachPersonFile.attachment).toEqual(first);
    expect(first).toMatchObject({
      archivedAt: null,
      fileId,
      label: "Identity document",
      personId,
      version: 1,
    });

    const [attachmentCount] = await fixture.database
      .select({ value: count() })
      .from(personFileAttachments)
      .where(
        and(
          eq(personFileAttachments.workspaceId, owner.workspaceId),
          eq(personFileAttachments.personId, personId),
          eq(personFileAttachments.fileId, fileId),
        ),
      );
    expect(attachmentCount?.value).toBe(1);

    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "person.file.attach"),
          eq(auditEvents.resourceId, personId),
        ),
      );
    expect(auditCount?.value).toBe(1);

    const [claim] = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.actorPrincipalId, owner.principalId),
          eq(
            locationMutationIdempotency.operation,
            "person_file_attachment.create.graphql",
          ),
        ),
      );
    expect(claim).toMatchObject({
      actorPrincipalId: owner.principalId,
      status: "completed",
    });
    expect(JSON.stringify(claim?.responseReference)).not.toContain(
      "Identity document",
    );

    const changed = await attach(fixture, owner, {
      ...input,
      label: "Changed label",
    });
    expectGraphQLError(changed, "CONFLICT");

    await fixture.database
      .update(personFileAttachments)
      .set({ version: 2 })
      .where(eq(personFileAttachments.id, first.id));
    expectGraphQLError(await attach(fixture, owner, input), "CONFLICT");
    await fixture.database
      .update(personFileAttachments)
      .set({ version: 1 })
      .where(eq(personFileAttachments.id, first.id));

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { attachmentId: [first.id], version: 1 } })
      .where(
        eq(locationMutationIdempotency.id, required(claim?.id, "claim ID")),
      );
    expectGraphQLError(
      await attach(fixture, owner, input),
      "VALIDATION_FAILED",
    );
  });

  it("replays an archived attachment exactly once and rejects a malformed archive reference", async () => {
    const owner = await fixture.createActor();
    const personId = await createPerson(fixture, owner, "Archive subject");
    const fileId = await createAvailableFile(fixture, owner);
    const attached = await attach(fixture, owner, { personId, fileId });
    const attachment = required(
      attached.body?.data?.attachPersonFile.attachment,
      "legacy attachment",
    );
    const input = {
      id: attachment.id,
      expectedVersion: attachment.version,
      idempotencyKey: "person-file-archive-replay-v1",
    };

    const [left, right] = await Promise.all([
      archive(fixture, owner, input),
      archive(fixture, owner, input),
    ]);
    expect(left.body?.errors).toBeUndefined();
    expect(right.body?.errors).toBeUndefined();
    const archived = required(
      left.body?.data?.archivePersonFile.attachment,
      "archived attachment",
    );
    expect(right.body?.data?.archivePersonFile.attachment).toEqual(archived);
    expect(archived).toMatchObject({ id: attachment.id, version: 2 });
    expect(archived.archivedAt).toBeTruthy();

    const replay = await archive(fixture, owner, input);
    expect(replay.body?.errors).toBeUndefined();
    expect(replay.body?.data?.archivePersonFile.attachment).toEqual(archived);

    const [auditCount] = await fixture.database
      .select({ value: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "person.file.detach"),
          eq(auditEvents.resourceId, personId),
        ),
      );
    expect(auditCount?.value).toBe(1);

    const [claim] = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "person_file_attachment.archive.graphql",
          ),
        ),
      );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { attachmentId: attachment.id, version: "2" } })
      .where(
        eq(locationMutationIdempotency.id, required(claim?.id, "claim ID")),
      );
    expectGraphQLError(
      await archive(fixture, owner, input),
      "VALIDATION_FAILED",
    );
  });

  it("takes over an expired attach claim after archival without duplicating a current attachment", async () => {
    const owner = await fixture.createActor();
    const personId = await createPerson(fixture, owner, "Takeover subject");
    const fileId = await createAvailableFile(fixture, owner);
    const input = {
      personId,
      fileId,
      label: "Reattachable",
      idempotencyKey: "person-file-attach-expiry-v1",
    };
    const first = required(
      (await attach(fixture, owner, input)).body?.data?.attachPersonFile
        .attachment,
      "initial attachment",
    );
    const [claim] = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "person_file_attachment.create.graphql",
          ),
        ),
      );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(
        eq(locationMutationIdempotency.id, required(claim?.id, "claim ID")),
      );

    const archived = await archive(fixture, owner, {
      id: first.id,
      expectedVersion: first.version,
    });
    expect(archived.body?.errors).toBeUndefined();
    const replacement = required(
      (await attach(fixture, owner, input)).body?.data?.attachPersonFile
        .attachment,
      "replacement attachment",
    );
    expect(replacement.id).not.toBe(first.id);
    expect(replacement).toMatchObject({ archivedAt: null, version: 1 });

    const rows = await fixture.database
      .select()
      .from(personFileAttachments)
      .where(
        and(
          eq(personFileAttachments.workspaceId, owner.workspaceId),
          eq(personFileAttachments.personId, personId),
          eq(personFileAttachments.fileId, fileId),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);

    const activeClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "person_file_attachment.create.graphql",
          ),
          gt(locationMutationIdempotency.expiresAt, new Date()),
        ),
      );
    expect(activeClaims).toHaveLength(1);
  });

  it("fences raw keys by both workspace and durable principal", async () => {
    const owner = await fixture.createActor();
    const contributor = await fixture.createWorkspaceMember(
      owner,
      "contributor",
    );
    const foreign = await fixture.createActor();
    const sharedKey = "person-file-principal-tenant-v1";

    const targets = await Promise.all(
      [owner, contributor, foreign].map(async (actor, index) => ({
        actor,
        fileId: await createAvailableFile(fixture, actor, `scope-${index}`),
        personId: await createPerson(fixture, actor, `Scoped person ${index}`),
      })),
    );
    const results = await Promise.all(
      targets.map(({ actor, fileId, personId }) =>
        attach(fixture, actor, {
          fileId,
          idempotencyKey: sharedKey,
          label: "Scoped attachment",
          personId,
        }),
      ),
    );
    expect(results.every((result) => !result.body?.errors)).toBe(true);
    expect(
      new Set(
        results.map((result) =>
          required(
            result.body?.data?.attachPersonFile.attachment?.id,
            "scoped attachment ID",
          ),
        ),
      ).size,
    ).toBe(3);

    const claims = await fixture.database
      .select({
        principalId: locationMutationIdempotency.actorPrincipalId,
        workspaceId: locationMutationIdempotency.workspaceId,
      })
      .from(locationMutationIdempotency)
      .where(
        eq(
          locationMutationIdempotency.operation,
          "person_file_attachment.create.graphql",
        ),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.principalId)).size).toBe(3);
    expect(new Set(claims.map((claim) => claim.workspaceId)).size).toBe(2);
  });
});
