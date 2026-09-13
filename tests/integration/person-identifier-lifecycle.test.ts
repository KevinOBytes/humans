// @vitest-environment node
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { personIdentifiers } from "@/db/schema/people";
import { auditEvents } from "@/db/schema/operations";
import { createPeopleService } from "@/modules/people/service";
import {
  CreatePersonIdentifierDocument,
  UpdatePersonIdentifierDocument,
  ArchivePersonIdentifierDocument,
} from "@/graphql/generated/graphql";
import { caseContext } from "../support/cases";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe("governed identifier lifecycle", () => {
  let fixture: ResearchFixture;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());
  it("executes the generated public lifecycle operations and rejects a viewer", async () => {
    const actor = await fixture.createActor();
    const person = await fixture.createPerson(actor, {
      displayName: "Generated identifier fixture",
    });
    const input = {
      personId: person.body!.data!.createPerson!.person!.id,
      namespace: "public-registry",
      identifierType: "profile",
      value: " Public-42 ",
      sensitivity: "PUBLIC",
      idempotencyKey: "graphql-identifier-create",
    };
    type Result = {
      id: string;
      version: number;
      value: string | null;
      redacted: boolean;
    };
    const create = await fixture.execute<{
      createPersonIdentifier: { identifier: Result };
    }>({
      jar: actor.jar,
      query: CreatePersonIdentifierDocument,
      operationName: "CreatePersonIdentifier",
      variables: { input },
    });
    expect(create.body?.errors).toBeUndefined();
    const row = create.body!.data!.createPersonIdentifier.identifier;
    expect(row).toMatchObject({
      value: "Public-42",
      redacted: false,
      version: 1,
    });
    const otherMember = await fixture.createWorkspaceMember(actor, "analyst");
    const otherCreate = await fixture.execute<{
      createPersonIdentifier: { identifier: Result };
    }>({
      jar: otherMember.jar,
      query: CreatePersonIdentifierDocument,
      operationName: "CreatePersonIdentifier",
      variables: { input },
    });
    expect(otherCreate.body?.errors).toBeUndefined();
    expect(
      otherCreate.body?.data?.createPersonIdentifier.identifier.id,
    ).not.toBe(row.id);
    const changedReplay = await fixture.execute({
      jar: actor.jar,
      query: CreatePersonIdentifierDocument,
      operationName: "CreatePersonIdentifier",
      variables: { input: { ...input, value: "Changed request" } },
    });
    expect(changedReplay.body?.errors?.[0]?.extensions?.code).toBe("CONFLICT");
    const update = await fixture.execute<{
      updatePersonIdentifier: { identifier: Result };
    }>({
      jar: actor.jar,
      query: UpdatePersonIdentifierDocument,
      operationName: "UpdatePersonIdentifier",
      variables: {
        input: {
          id: row.id,
          expectedVersion: 1,
          value: "Public-43",
          idempotencyKey: "graphql-identifier-update",
        },
      },
    });
    expect(update.body?.errors).toBeUndefined();
    expect(update.body?.data?.updatePersonIdentifier.identifier).toMatchObject({
      version: 2,
      value: "Public-43",
    });
    const viewer = await fixture.createWorkspaceMember(actor, "viewer");
    const denied = await fixture.execute({
      jar: viewer.jar,
      query: CreatePersonIdentifierDocument,
      operationName: "CreatePersonIdentifier",
      variables: { input },
    });
    expect(denied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    const archived = await fixture.execute<{
      archivePersonIdentifier: { identifier: Result };
    }>({
      jar: actor.jar,
      query: ArchivePersonIdentifierDocument,
      operationName: "ArchivePersonIdentifier",
      variables: {
        input: {
          id: row.id,
          expectedVersion: 2,
          idempotencyKey: "graphql-identifier-archive",
        },
      },
    });
    expect(archived.body?.errors).toBeUndefined();
    expect(
      archived.body?.data?.archivePersonIdentifier.identifier.version,
    ).toBe(3);
  });
  it("converges retries, fences versions, protects stored values and archives once", async () => {
    const actor = await fixture.createActor();
    const createdPerson = await fixture.createPerson(actor, {
      displayName: "Identifier fixture",
    });
    const personId = createdPerson.body!.data!.createPerson!.person!.id;
    const context = {
      ...(await caseContext(fixture, actor)),
      protectedExactRuntime: {
        blindIndexKey: "12".repeat(32),
        encryptionKey: "34".repeat(32),
      },
    };
    const service = createPeopleService(context);
    const input = {
      personId,
      namespace: "registry",
      identifierType: "profile",
      value: "sensitive-42",
      sensitivity: "confidential",
      idempotencyKey: "identifier-create",
    };
    const [first, replay] = await Promise.all([
      service.createIdentifier(input),
      service.createIdentifier(input),
    ]);
    expect(first.resource).toMatchObject({
      value: null,
      redacted: true,
      version: 1,
    });
    expect(replay).toEqual(first);
    const id = first.resource!.id;
    const [stored] = await fixture.database
      .select()
      .from(personIdentifiers)
      .where(eq(personIdentifiers.id, id));
    expect(stored!.normalizedValue).toBeNull();
    expect(stored!.encryptedRawValue).not.toContain("sensitive-42");
    expect(stored!.blindIndex).toMatch(/^[0-9a-f]{64}$/);
    const update = {
      id,
      expectedVersion: 1,
      issuer: "Synthetic issuer",
      idempotencyKey: "identifier-update",
    };
    const changed = await service.updateIdentifier(update);
    expect(changed.resource).toMatchObject({
      version: 2,
      issuer: "Synthetic issuer",
      value: null,
    });
    expect(await service.updateIdentifier(update)).toEqual(changed);
    await expect(
      service.updateIdentifier({ id, expectedVersion: 1, issuer: "stale" }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    await expect(
      service.updateIdentifier({
        id,
        expectedVersion: 2,
        sensitivity: "public",
      }),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    const archive = {
      id,
      expectedVersion: 2,
      idempotencyKey: "identifier-archive",
    };
    const archived = await service.archiveIdentifier(archive);
    expect(archived.resource!.version).toBe(3);
    expect(await service.archiveIdentifier(archive)).toEqual(archived);
    expect((await service.listIdentifiers({ personId })).nodes).toHaveLength(0);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.resourceId, id),
        ),
      );
    expect(audits.map((row) => row.action).sort()).toEqual([
      "personIdentifier.archive",
      "personIdentifier.create",
      "personIdentifier.update",
    ]);
    expect(JSON.stringify(audits)).not.toContain("sensitive-42");
  });
  it("rejects cross-workspace writes and callers lacking write permission", async () => {
    const owner = await fixture.createActor();
    const other = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Tenant fixture",
    });
    const input = {
      personId: person.body!.data!.createPerson!.person!.id,
      namespace: "registry",
      identifierType: "profile",
      value: "42",
      sensitivity: "public",
    };
    const context = await caseContext(fixture, other);
    await expect(
      createPeopleService(context).createIdentifier(input),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await expect(
      createPeopleService({
        ...context,
        permissions: new Set(),
      }).createIdentifier(input),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});
