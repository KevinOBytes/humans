// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  ArchiveTagDocument,
  CreateFactDefinitionDocument,
  CreateFactDocument,
  CreateRelationshipDocument,
  CreateRelationshipTypeDocument,
  CreateTagDocument,
  TagFactDocument,
  TagPersonDocument,
  TagRelationshipDocument,
  UntagFactDocument,
  UntagPersonDocument,
  UntagRelationshipDocument,
  UpdateTagDocument,
} from "@/graphql/generated/graphql";
import { auditEvents } from "@/db/schema/operations";
import { factTags, personTags, relationshipTags } from "@/db/schema/evidence";
import { locationMutationIdempotency } from "@/db/schema/locations";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("remaining tag mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function setup(actor: SessionActor, suffix: string) {
    const [sourceResult, targetResult] = await Promise.all([
      fixture.createPerson(actor, { displayName: `${suffix} source` }),
      fixture.createPerson(actor, { displayName: `${suffix} target` }),
    ]);
    const sourceId = required(
      sourceResult.body?.data?.createPerson?.person?.id,
      "source person",
    );
    const targetId = required(
      targetResult.body?.data?.createPerson?.person?.id,
      "target person",
    );
    const definition = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateFactDefinition",
      query: CreateFactDefinitionDocument,
      variables: {
        input: {
          namespace: "tag-idempotency",
          fieldKey: `${suffix.toLowerCase().replaceAll(" ", "-")}-fact`,
          label: `${suffix} fact`,
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        },
      },
    });
    const definitionId = required(
      definition.body?.data?.createFactDefinition.factDefinition?.id,
      "fact definition",
    );
    const fact = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateFact",
      query: CreateFactDocument,
      variables: {
        input: {
          personId: sourceId,
          definitionId,
          value: { text: `${suffix} value` },
        },
      },
    });
    const factId = required(fact.body?.data?.createFact.fact?.id, "fact");
    const relationshipType = await fixture.execute<{
      createRelationshipType: { relationshipType: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateRelationshipType",
      query: CreateRelationshipTypeDocument,
      variables: {
        input: {
          namespace: "tag-idempotency",
          key: `${suffix.toLowerCase().replaceAll(" ", "-")}-relationship`,
          forwardLabel: "knows",
          inverseLabel: "known by",
        },
      },
    });
    const relationshipTypeId = required(
      relationshipType.body?.data?.createRelationshipType.relationshipType?.id,
      "relationship type",
    );
    const relationship = await fixture.execute<{
      createRelationship: { relationship: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateRelationship",
      query: CreateRelationshipDocument,
      variables: {
        input: {
          sourcePersonId: sourceId,
          targetPersonId: targetId,
          relationshipTypeId,
        },
      },
    });
    const relationshipId = required(
      relationship.body?.data?.createRelationship.relationship?.id,
      "relationship",
    );
    const tag = await fixture.execute<{
      createTag: { tag: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateTag",
      query: CreateTagDocument,
      variables: { input: { name: `${suffix} tag`, color: "#aabbcc" } },
    });
    const tagId = required(tag.body?.data?.createTag.tag?.id, "tag");
    return { sourceId, factId, relationshipId, tagId };
  }

  it("replays update/archive with malformed, expiry, and material fencing", async () => {
    const actor = await fixture.createActor();
    const { tagId } = await setup(actor, "Tag lifecycle");
    const updateInput = {
      id: tagId,
      expectedVersion: 1,
      idempotencyKey: "tag-update-replay-v1",
      color: "#112233",
      description: "updated",
    };
    const update = () =>
      fixture.execute<{
        updateTag: {
          code: string | null;
          tag: { id: string; version: number } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "UpdateTag",
        query: UpdateTagDocument,
        variables: { input: updateInput },
      });
    const [first, replay] = await Promise.all([update(), update()]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const updated = required(first.body?.data?.updateTag.tag, "updated tag");
    expect(replay.body?.data?.updateTag.tag).toEqual(updated);
    const updateClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(locationMutationIdempotency.operation, "tag.update.graphql"),
        ),
      );
    expect(updateClaims).toHaveLength(1);
    expect(updateClaims[0]?.responseReference).toEqual({ tagId });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "tag.update"),
          ),
        ),
    ).toHaveLength(1);

    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        operationName: "UpdateTag",
        query: UpdateTagDocument,
        variables: {
          input: { ...updateInput, name: "different material" },
        },
      }),
      "CONFLICT",
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { tagId: "not-a-uuid" } })
      .where(
        eq(
          locationMutationIdempotency.id,
          required(updateClaims[0], "update claim").id,
        ),
      );
    expectGraphQLError(await update(), "PRECONDITION_FAILED");

    const expiryInput = {
      ...updateInput,
      idempotencyKey: "tag-update-expiry-v1",
      expectedVersion: updated.version,
      description: "expiry takeover",
    };
    const beforeExpiry = await fixture.execute<{
      updateTag: { tag: { id: string; version: number } | null };
    }>({
      jar: actor.jar,
      operationName: "UpdateTag",
      query: UpdateTagDocument,
      variables: { input: expiryInput },
    });
    const expiryTag = required(
      beforeExpiry.body?.data?.updateTag.tag,
      "expiry tag",
    );
    const expiryClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(locationMutationIdempotency.operation, "tag.update.graphql"),
        ),
      );
    const expiryClaim = required(
      [...expiryClaims]
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )
        .at(-1),
      "expiry claim",
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, expiryClaim.id));
    const takeover = await fixture.execute<{
      updateTag: {
        code: string | null;
        currentVersion: number | null;
        tag: { id: string; version: number } | null;
      };
    }>({
      jar: actor.jar,
      operationName: "UpdateTag",
      query: UpdateTagDocument,
      variables: { input: expiryInput },
    });
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeover.body?.data?.updateTag).toMatchObject({
      code: "CONFLICT",
      currentVersion: expiryTag.version,
      tag: null,
    });

    const archiveInput = {
      id: tagId,
      expectedVersion:
        takeover.body?.data?.updateTag.currentVersion ?? expiryTag.version,
      idempotencyKey: "tag-archive-replay-v1",
    };
    const archive = () =>
      fixture.execute<{
        archiveTag: { tag: { id: string; version: number } | null };
      }>({
        jar: actor.jar,
        operationName: "ArchiveTag",
        query: ArchiveTagDocument,
        variables: { input: archiveInput },
      });
    const [archived, archiveReplay] = await Promise.all([archive(), archive()]);
    expect(archived.body?.errors).toBeUndefined();
    expect(archiveReplay.body?.data?.archiveTag.tag).toEqual(
      archived.body?.data?.archiveTag.tag,
    );
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "tag.archive"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("replays fact and relationship tag/untag operations with durable outcomes", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const { sourceId, factId, relationshipId, tagId } = await setup(
      actor,
      "Association",
    );
    const tagFactInput = {
      factId,
      tagId,
      idempotencyKey: "tag-fact-replay-v1",
    };
    const tagFact = () =>
      fixture.execute<{
        tagFact: {
          factTag: { id: string; factId: string; tagId: string } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "TagFact",
        query: TagFactDocument,
        variables: { input: tagFactInput },
      });
    const [taggedFact, replayedFact] = await Promise.all([
      tagFact(),
      tagFact(),
    ]);
    expect(taggedFact.body?.errors).toBeUndefined();
    expect(replayedFact.body?.data?.tagFact.factTag).toEqual(
      taggedFact.body?.data?.tagFact.factTag,
    );
    const factTag = required(
      taggedFact.body?.data?.tagFact.factTag,
      "fact tag",
    );
    expect(
      await fixture.database
        .select({ id: factTags.id })
        .from(factTags)
        .where(
          and(
            eq(factTags.workspaceId, actor.workspaceId),
            eq(factTags.factId, factId),
            eq(factTags.tagId, tagId),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "tag.fact"),
          ),
        ),
    ).toHaveLength(1);

    const foreignSetup = await setup(foreign, "Foreign association");
    const foreignTagFact = await fixture.execute<{
      tagFact: { factTag: { id: string } | null };
    }>({
      jar: foreign.jar,
      operationName: "TagFact",
      query: TagFactDocument,
      variables: {
        input: {
          factId: foreignSetup.factId,
          tagId: foreignSetup.tagId,
          idempotencyKey: tagFactInput.idempotencyKey,
        },
      },
    });
    expect(foreignTagFact.body?.errors).toBeUndefined();
    expect(foreignTagFact.body?.data?.tagFact.factTag?.id).not.toBe(factTag.id);

    const tagPerson = await fixture.execute<{
      tagPerson: { personTag: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "TagPerson",
      query: TagPersonDocument,
      variables: {
        input: {
          personId: sourceId,
          tagId,
          idempotencyKey: "tag-person-for-untag-v1",
        },
      },
    });
    const personTag = required(
      tagPerson.body?.data?.tagPerson.personTag,
      "person tag",
    );
    const untagPersonInput = {
      personId: sourceId,
      tagId,
      idempotencyKey: "untag-person-replay-v1",
    };
    const untagPerson = () =>
      fixture.execute<{
        untagPerson: { personTag: { id: string } | null };
      }>({
        jar: actor.jar,
        operationName: "UntagPerson",
        query: UntagPersonDocument,
        variables: { input: untagPersonInput },
      });
    const [untaggedPerson, replayedPerson] = await Promise.all([
      untagPerson(),
      untagPerson(),
    ]);
    expect(untaggedPerson.body?.errors).toBeUndefined();
    expect(replayedPerson.body?.data?.untagPerson.personTag).toEqual(personTag);
    expect(
      await fixture.database
        .select({ id: personTags.id })
        .from(personTags)
        .where(
          and(
            eq(personTags.workspaceId, actor.workspaceId),
            eq(personTags.personId, sourceId),
            eq(personTags.tagId, tagId),
          ),
        ),
    ).toHaveLength(0);

    const untagFactInput = {
      factId,
      tagId,
      idempotencyKey: "untag-fact-replay-v1",
    };
    const untagFact = () =>
      fixture.execute<{
        untagFact: {
          factTag: { id: string; factId: string; tagId: string } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "UntagFact",
        query: UntagFactDocument,
        variables: { input: untagFactInput },
      });
    const [untaggedFact, replayedUntag] = await Promise.all([
      untagFact(),
      untagFact(),
    ]);
    expect(untaggedFact.body?.errors).toBeUndefined();
    expect(replayedUntag.body?.data?.untagFact.factTag).toEqual(factTag);
    const untagClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
          eq(locationMutationIdempotency.operation, "untag.fact.graphql"),
        ),
      );
    expect(untagClaims).toHaveLength(1);
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { outcome: "not-json" } })
      .where(
        eq(
          locationMutationIdempotency.id,
          required(untagClaims[0], "untag claim").id,
        ),
      );
    expectGraphQLError(await untagFact(), "PRECONDITION_FAILED");

    const tagRelationshipInput = {
      relationshipId,
      tagId,
      idempotencyKey: "tag-relationship-replay-v1",
    };
    const tagRelationship = () =>
      fixture.execute<{
        tagRelationship: {
          relationshipTag: {
            id: string;
            relationshipId: string;
            tagId: string;
          } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "TagRelationship",
        query: TagRelationshipDocument,
        variables: { input: tagRelationshipInput },
      });
    const [taggedRelationship, replayedRelationship] = await Promise.all([
      tagRelationship(),
      tagRelationship(),
    ]);
    expect(taggedRelationship.body?.errors).toBeUndefined();
    expect(
      replayedRelationship.body?.data?.tagRelationship.relationshipTag,
    ).toEqual(taggedRelationship.body?.data?.tagRelationship.relationshipTag);
    expect(
      await fixture.database
        .select({ id: relationshipTags.id })
        .from(relationshipTags)
        .where(
          and(
            eq(relationshipTags.workspaceId, actor.workspaceId),
            eq(relationshipTags.relationshipId, relationshipId),
            eq(relationshipTags.tagId, tagId),
          ),
        ),
    ).toHaveLength(1);

    const untagRelationshipInput = {
      relationshipId,
      tagId,
      idempotencyKey: "untag-relationship-replay-v1",
    };
    const untagRelationship = () =>
      fixture.execute<{
        untagRelationship: {
          relationshipTag: {
            id: string;
            relationshipId: string;
            tagId: string;
          } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "UntagRelationship",
        query: UntagRelationshipDocument,
        variables: { input: untagRelationshipInput },
      });
    const [untaggedRelationship, replayedUntagRelationship] = await Promise.all(
      [untagRelationship(), untagRelationship()],
    );
    expect(untaggedRelationship.body?.errors).toBeUndefined();
    expect(
      replayedUntagRelationship.body?.data?.untagRelationship.relationshipTag,
    ).toEqual(
      untaggedRelationship.body?.data?.untagRelationship.relationshipTag,
    );
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "untag.relationship"),
          ),
        ),
    ).toHaveLength(1);
  });
});
