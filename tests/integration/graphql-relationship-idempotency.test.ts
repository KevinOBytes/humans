// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  ArchiveRelationshipDocument,
  CreateRelationshipDocument,
  CreateRelationshipTypeDocument,
  UpdateRelationshipDocument,
} from "@/graphql/generated/graphql";
import { auditEvents } from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { relationships } from "@/db/schema/relationships";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("relationship edge mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function relationshipSetup(actor: SessionActor, suffix: string) {
    const [source, target] = await Promise.all([
      fixture.createPerson(actor, { displayName: `${suffix} source` }),
      fixture.createPerson(actor, { displayName: `${suffix} target` }),
    ]);
    const sourceId = required(
      source.body?.data?.createPerson?.person?.id,
      "source person",
    );
    const targetId = required(
      target.body?.data?.createPerson?.person?.id,
      "target person",
    );
    const type = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateRelationshipType",
      query: CreateRelationshipTypeDocument,
      variables: {
        input: {
          key: `${suffix.toLowerCase().replaceAll(" ", "_")}_knows`,
          namespace: "idempotency",
          forwardLabel: "knows",
          inverseLabel: "known by",
        },
      },
    });
    return {
      sourceId,
      targetId,
      relationshipTypeId: required(
        type.body?.data?.createRelationshipType.relationshipType?.id,
        "relationship type",
      ),
    };
  }

  it("converges concurrent create calls and fences replay claims", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const ownerSetup = await relationshipSetup(owner, "Owner Edge");
    const foreignSetup = await relationshipSetup(foreign, "Foreign Edge");
    const input = {
      idempotencyKey: "relationship-create-replay-v1",
      sourcePersonId: ownerSetup.sourceId,
      targetPersonId: ownerSetup.targetId,
      relationshipTypeId: ownerSetup.relationshipTypeId,
      labelOverride: "research contact",
      metadata: { source: "fixture", rank: 1 },
    };
    const create = (actor: SessionActor, variables: typeof input) =>
      fixture.execute<{
        createRelationship: {
          code: string | null;
          relationship: { id: string; version: number } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "CreateRelationship",
        query: CreateRelationshipDocument,
        variables: { input: variables },
      });

    const [first, replay] = await Promise.all([
      create(owner, input),
      create(owner, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const firstRelationship = required(
      first.body?.data?.createRelationship.relationship,
      "created relationship",
    );
    expect(replay.body?.data?.createRelationship.relationship).toEqual(
      firstRelationship,
    );

    const rows = await fixture.database
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.workspaceId, owner.workspaceId),
          eq(relationships.sourcePersonId, ownerSetup.sourceId),
        ),
      );
    expect(rows).toHaveLength(1);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "relationship.create.graphql",
          ),
        ),
      );
    expect(claims).toHaveLength(1);
    const claim = required(claims[0], "relationship claim");
    expect(claim.responseReference).toEqual({
      relationshipId: firstRelationship.id,
      version: firstRelationship.version,
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "relationship.create"),
          ),
        ),
    ).toHaveLength(1);

    const changed = await create(owner, {
      ...input,
      targetPersonId: ownerSetup.sourceId,
    });
    expectGraphQLError(changed, "CONFLICT");

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { relationshipId: "not-a-uuid", version: 1 } })
      .where(eq(locationMutationIdempotency.id, claim.id));
    expectGraphQLError(await create(owner, input), "PRECONDITION_FAILED");

    const foreignResult = await create(foreign, {
      ...input,
      idempotencyKey: input.idempotencyKey,
      sourcePersonId: foreignSetup.sourceId,
      targetPersonId: foreignSetup.targetId,
      relationshipTypeId: foreignSetup.relationshipTypeId,
    });
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(
      foreignResult.body?.data?.createRelationship.relationship?.id,
    ).not.toBe(firstRelationship.id);
  });

  it("replays update and archive, including an archived response reference", async () => {
    const owner = await fixture.createActor();
    const setup = await relationshipSetup(owner, "Lifecycle Edge");
    const created = await fixture.execute<{
      createRelationship: {
        relationship: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      operationName: "CreateRelationship",
      query: CreateRelationshipDocument,
      variables: {
        input: {
          sourcePersonId: setup.sourceId,
          targetPersonId: setup.targetId,
          relationshipTypeId: setup.relationshipTypeId,
        },
      },
    });
    const relationship = required(
      created.body?.data?.createRelationship.relationship,
      "lifecycle relationship",
    );

    const updateInput = {
      id: relationship.id,
      expectedVersion: relationship.version,
      idempotencyKey: "relationship-update-replay-v1",
      labelOverride: "updated label",
      strength: 0.7,
    };
    const update = () =>
      fixture.execute<{
        updateRelationship: {
          relationship: { id: string; version: number } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "UpdateRelationship",
        query: UpdateRelationshipDocument,
        variables: { input: updateInput },
      });
    const [updated, replayedUpdate] = await Promise.all([update(), update()]);
    expect(updated.body?.errors).toBeUndefined();
    expect(replayedUpdate.body?.errors).toBeUndefined();
    const updatedRelationship = required(
      updated.body?.data?.updateRelationship.relationship,
      "updated relationship",
    );
    expect(replayedUpdate.body?.data?.updateRelationship.relationship).toEqual(
      updatedRelationship,
    );
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "relationship.update"),
          ),
        ),
    ).toHaveLength(1);

    const omittedLabelInput = {
      id: relationship.id,
      expectedVersion: updatedRelationship.version,
      idempotencyKey: "relationship-update-presence-v1",
      strength: 0.8,
    };
    const omittedLabel = await fixture.execute<{
      updateRelationship: {
        relationship: { id: string; version: number } | null;
      };
    }>({
      jar: owner.jar,
      operationName: "UpdateRelationship",
      query: UpdateRelationshipDocument,
      variables: { input: omittedLabelInput },
    });
    expect(omittedLabel.body?.errors).toBeUndefined();
    const omittedLabelRelationship = required(
      omittedLabel.body?.data?.updateRelationship.relationship,
      "omitted-label relationship",
    );
    const explicitSentinel = await fixture.execute({
      jar: owner.jar,
      operationName: "UpdateRelationship",
      query: UpdateRelationshipDocument,
      variables: {
        input: { ...omittedLabelInput, labelOverride: "__unchanged__" },
      },
    });
    expectGraphQLError(explicitSentinel, "CONFLICT");
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "relationship.update"),
          ),
        ),
    ).toHaveLength(2);

    const archiveInput = {
      id: relationship.id,
      expectedVersion: omittedLabelRelationship.version,
      idempotencyKey: "relationship-archive-replay-v1",
    };
    const archive = () =>
      fixture.execute<{
        archiveRelationship: {
          relationship: { id: string; version: number } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "ArchiveRelationship",
        query: ArchiveRelationshipDocument,
        variables: { input: archiveInput },
      });
    const [archived, replayedArchive] = await Promise.all([
      archive(),
      archive(),
    ]);
    expect(archived.body?.errors).toBeUndefined();
    expect(replayedArchive.body?.errors).toBeUndefined();
    const archivedRelationship = required(
      archived.body?.data?.archiveRelationship.relationship,
      "archived relationship",
    );
    expect(
      replayedArchive.body?.data?.archiveRelationship.relationship,
    ).toEqual(archivedRelationship);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "relationship.archive"),
          ),
        ),
    ).toHaveLength(1);
    const archivedReplay = await archive();
    expect(archivedReplay.body?.errors).toBeUndefined();
    expect(archivedReplay.body?.data?.archiveRelationship.relationship).toEqual(
      archivedRelationship,
    );
  });
});
