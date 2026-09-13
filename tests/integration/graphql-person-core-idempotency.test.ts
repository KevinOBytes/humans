// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import {
  ArchivePersonDocument,
  CreatePersonDocument,
  UpdatePersonDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
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
});
