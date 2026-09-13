// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import {
  ArchivePersonDocument,
  CreatePersonDocument,
  UpdatePersonDocument,
} from "@/graphql/generated/graphql";
import {
  deriveResearchIdempotency,
  runIdempotentResearchWrite,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
import { createPeopleService } from "@/modules/people/service";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { caseContext } from "../support/cases";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type Person = { id: string; version: number; displayName?: string };

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Expected ${label}`);
  return value;
}

liveDescribe("generated core-person mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  function create(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{ createPerson: { person: Person | null } }>({
      jar: actor.jar,
      operationName: "CreatePerson",
      query: CreatePersonDocument,
      variables: { input },
    });
  }

  function update(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{ updatePerson: { person: Person | null } }>({
      jar: actor.jar,
      operationName: "UpdatePerson",
      query: UpdatePersonDocument,
      variables: { input },
    });
  }

  function archive(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{ archivePerson: { person: Person | null } }>({
      jar: actor.jar,
      operationName: "ArchivePerson",
      query: ArchivePersonDocument,
      variables: { input },
    });
  }

  async function claim(actor: SessionActor, operation: string) {
    return required(
      (
        await fixture.database
          .select()
          .from(locationMutationIdempotency)
          .where(
            and(
              eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
              eq(locationMutationIdempotency.operation, operation),
            ),
          )
      )[0],
      `${operation} claim`,
    );
  }

  async function legacyCorePersonClaim(
    actor: SessionActor,
    input: {
      operation: "person.create" | "person.update" | "person.archive";
      idempotencyKey: string;
      requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
      responseReference: ResearchResponseReference;
    },
  ) {
    const context = {
      ...(await caseContext(fixture, actor)),
      // GraphQL core-person mutations use the test AI runtime's HMAC key.
      idempotencyHmacKey: "42".repeat(32),
    };
    const idempotency = deriveResearchIdempotency(context, {
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      requestMaterial: input.requestMaterial,
      secret: context.idempotencyHmacKey,
    });
    await runIdempotentResearchWrite(
      context,
      idempotency,
      input.operation === "person.create"
        ? ["person:create"]
        : ["person:update"],
      async () => input.responseReference,
    );
  }

  it("converges create, update, and archive replay with a principal claim and one audit per mutation", async () => {
    const actor = await fixture.createActor();
    const createInput = {
      displayName: "Core retry subject",
      idempotencyKey: "person-core-create-v1",
    };
    const [firstCreate, replayCreate] = await Promise.all([
      create(actor, createInput),
      create(actor, createInput),
    ]);
    expect(firstCreate.body?.errors).toBeUndefined();
    expect(replayCreate.body?.errors).toBeUndefined();
    const created = required(
      firstCreate.body?.data?.createPerson.person,
      "created person",
    );
    expect(replayCreate.body?.data?.createPerson.person).toEqual(created);

    const updateInput = {
      id: created.id,
      expectedVersion: created.version,
      displayName: "Core retry subject, updated",
      idempotencyKey: "person-core-update-v1",
    };
    const [firstUpdate, replayUpdate] = await Promise.all([
      update(actor, updateInput),
      update(actor, updateInput),
    ]);
    expect(firstUpdate.body?.errors).toBeUndefined();
    expect(replayUpdate.body?.errors).toBeUndefined();
    const updated = required(
      firstUpdate.body?.data?.updatePerson.person,
      "updated person",
    );
    expect(replayUpdate.body?.data?.updatePerson.person).toEqual(updated);

    const archiveInput = {
      id: updated.id,
      expectedVersion: updated.version,
      idempotencyKey: "person-core-archive-v1",
    };
    const [firstArchive, replayArchive] = await Promise.all([
      archive(actor, archiveInput),
      archive(actor, archiveInput),
    ]);
    expect(firstArchive.body?.errors).toBeUndefined();
    expect(replayArchive.body?.errors).toBeUndefined();
    expect(replayArchive.body?.data?.archivePerson.person).toEqual(
      firstArchive.body?.data?.archivePerson.person,
    );

    for (const [operation, action] of [
      ["person.create.graphql", "person.create"],
      ["person.update.graphql", "person.update"],
      ["person.archive.graphql", "person.archive"],
    ] as const) {
      const claims = await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(
          and(
            eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
            eq(locationMutationIdempotency.operation, operation),
          ),
        );
      expect(claims).toHaveLength(1);
      expect(claims[0]?.actorPrincipalId).toBe(actor.principalId);
      expect(JSON.stringify(claims)).not.toContain("person-core-");
      expect(
        await fixture.database
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.workspaceId, actor.workspaceId),
              eq(auditEvents.action, action),
            ),
          ),
      ).toHaveLength(1);
    }
  });

  it("rejects changed material and malformed references, serializes expiry takeover, and fences workspace and principal", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "contributor");
    const foreign = await fixture.createActor();
    const input = {
      displayName: "Replay fence subject",
      idempotencyKey: "person-core-fence-v1",
    };
    const initial = await create(owner, input);
    expect(initial.body?.errors).toBeUndefined();
    const first = required(
      initial.body?.data?.createPerson.person,
      "fenced person",
    );
    await expectGraphQLError(
      await create(owner, { ...input, displayName: "Changed material" }),
      "CONFLICT",
    );

    const createClaim = await claim(owner, "person.create.graphql");
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { personId: "not-a-uuid" } })
      .where(eq(locationMutationIdempotency.id, createClaim.id));
    await expectGraphQLError(await create(owner, input), "VALIDATION_FAILED");

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: { personId: first.id },
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(locationMutationIdempotency.id, createClaim.id));
    const [takeover, takeoverReplay] = await Promise.all([
      create(owner, input),
      create(owner, input),
    ]);
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeoverReplay.body?.errors).toBeUndefined();
    expect(takeoverReplay.body?.data?.createPerson.person).toEqual(
      takeover.body?.data?.createPerson.person,
    );
    expect(takeover.body?.data?.createPerson.person?.id).not.toBe(first.id);

    const memberResult = await create(member, input);
    expect(memberResult.body?.errors).toBeUndefined();
    expect(memberResult.body?.data?.createPerson.person?.id).not.toBe(first.id);
    const foreignResult = await create(foreign, input);
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.data?.createPerson.person?.id).not.toBe(
      first.id,
    );
  });

  it("replays unexpired pre-principal core-person claims without creating principal claims or duplicate effects", async () => {
    const actor = await fixture.createActor();
    const createKey = "legacy-core-create-v1";
    const created = required(
      (await fixture.createPerson(actor, { displayName: "Legacy create" })).body
        ?.data?.createPerson?.person,
      "legacy-created person",
    );
    await legacyCorePersonClaim(actor, {
      operation: "person.create",
      idempotencyKey: createKey,
      requestMaterial: {
        biography: null,
        confidence: "1",
        confidenceExplanation: null,
        displayName: "Legacy create",
        preferredName: null,
        sensitivity: "internal",
        sortName: null,
        status: "active",
      },
      // This is the exact old create contract: no version was persisted.
      responseReference: { personId: created.id },
    });
    const createReplay = await create(actor, {
      displayName: "Legacy create",
      idempotencyKey: createKey,
    });
    expect(createReplay.body?.errors).toBeUndefined();
    expect(createReplay.body?.data?.createPerson.person?.id).toBe(created.id);

    const updateContext = await caseContext(fixture, actor);
    const updated = required(
      (
        await createPeopleService(updateContext).update({
          id: created.id,
          expectedVersion: created.version,
          displayName: "Legacy updated",
        })
      ).resource,
      "legacy-updated person",
    );
    const updateKey = "legacy-core-update-v1";
    await legacyCorePersonClaim(actor, {
      operation: "person.update",
      idempotencyKey: updateKey,
      requestMaterial: {
        biography: { present: false, value: null },
        displayName: { present: true, value: "Legacy updated" },
        expectedVersion: created.version,
        id: created.id,
        preferredName: { present: false, value: null },
        sensitivity: { present: false, value: null },
        sortName: { present: false, value: null },
        status: { present: false, value: null },
      },
      responseReference: { personId: updated.id, version: updated.version },
    });
    const updateReplay = await update(actor, {
      id: created.id,
      expectedVersion: created.version,
      displayName: "Legacy updated",
      idempotencyKey: updateKey,
    });
    expect(updateReplay.body?.errors).toBeUndefined();
    expect(updateReplay.body?.data?.updatePerson.person).toMatchObject({
      displayName: updated.displayName,
      id: updated.id,
      version: updated.version,
    });

    const archiveContext = await caseContext(fixture, actor);
    const archived = required(
      (
        await createPeopleService(archiveContext).archive({
          id: updated.id,
          expectedVersion: updated.version,
        })
      ).resource,
      "legacy-archived person",
    );
    const archiveKey = "legacy-core-archive-v1";
    await legacyCorePersonClaim(actor, {
      operation: "person.archive",
      idempotencyKey: archiveKey,
      requestMaterial: { expectedVersion: updated.version, id: updated.id },
      responseReference: { personId: archived.id, version: archived.version },
    });
    const archiveReplay = await archive(actor, {
      id: updated.id,
      expectedVersion: updated.version,
      idempotencyKey: archiveKey,
    });
    expect(archiveReplay.body?.errors).toBeUndefined();
    expect(archiveReplay.body?.data?.archivePerson.person).toMatchObject({
      id: archived.id,
      version: archived.version,
    });

    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(eq(locationMutationIdempotency.workspaceId, actor.workspaceId)),
    ).toEqual([]);
    expect(
      (
        await fixture.database
          .select({ operation: idempotencyKeys.operation })
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.workspaceId, actor.workspaceId))
      )
        .map(({ operation }) => operation)
        .sort(),
    ).toEqual(["person.archive", "person.create", "person.update"]);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, actor.workspaceId)),
    ).toHaveLength(3);
  });
});
