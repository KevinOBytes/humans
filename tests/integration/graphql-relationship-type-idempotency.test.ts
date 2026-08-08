// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  CreateRelationshipTypeDocument,
  UpdateRelationshipTypeDocument,
} from "@/graphql/generated/graphql";
import { auditEvents } from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { relationshipTypes } from "@/db/schema/relationships";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("relationship type mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  function createType(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{
      createRelationshipType: {
        code: string | null;
        relationshipType: { id: string; version: number } | null;
      };
    }>({
      jar: actor.jar,
      operationName: "CreateRelationshipType",
      query: CreateRelationshipTypeDocument,
      variables: { input },
    });
  }

  it("converges concurrent create calls and fences raw keys by workspace", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const input = {
      idempotencyKey: "relationship-type-create-replay-v1",
      namespace: "idempotency",
      key: "knows",
      forwardLabel: "knows",
      inverseLabel: "known by",
      metadataSchema: { source: "fixture" },
    };

    const [first, replay] = await Promise.all([
      createType(owner, input),
      createType(owner, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const firstType = required(
      first.body?.data?.createRelationshipType.relationshipType,
      "created relationship type",
    );
    expect(replay.body?.data?.createRelationshipType.relationshipType).toEqual(
      firstType,
    );

    const rows = await fixture.database
      .select()
      .from(relationshipTypes)
      .where(eq(relationshipTypes.workspaceId, owner.workspaceId));
    expect(rows).toHaveLength(1);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            "relationship_type.create.graphql",
          ),
        ),
      );
    expect(claims).toHaveLength(1);
    expect(
      required(claims[0], "relationship type claim").responseReference,
    ).toEqual({
      relationshipTypeId: firstType.id,
      version: firstType.version,
    });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "relationshipType.create"),
          ),
        ),
    ).toHaveLength(1);

    const changed = await createType(owner, {
      ...input,
      forwardLabel: "reports to",
    });
    expectGraphQLError(changed, "CONFLICT");

    const claim = required(claims[0], "relationship type claim");
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: { relationshipTypeId: "not-a-uuid", version: 1 },
      })
      .where(eq(locationMutationIdempotency.id, claim.id));
    expectGraphQLError(await createType(owner, input), "PRECONDITION_FAILED");

    const foreignResult = await createType(foreign, input);
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(
      foreignResult.body?.data?.createRelationshipType.relationshipType?.id,
    ).not.toBe(firstType.id);
  });

  it("replays concurrent updates and rejects changed request material", async () => {
    const owner = await fixture.createActor();
    const created = await createType(owner, {
      namespace: "idempotency",
      key: "updates",
      forwardLabel: "updates",
      inverseLabel: "updated by",
    });
    const type = required(
      created.body?.data?.createRelationshipType.relationshipType,
      "relationship type",
    );
    const input = {
      id: type.id,
      expectedVersion: type.version,
      idempotencyKey: "relationship-type-update-replay-v1",
      forwardLabel: "updates often",
      allowsSelf: true,
    };
    const update = () =>
      fixture.execute<{
        updateRelationshipType: {
          relationshipType: { id: string; version: number } | null;
        };
      }>({
        jar: owner.jar,
        operationName: "UpdateRelationshipType",
        query: UpdateRelationshipTypeDocument,
        variables: { input },
      });
    const [first, replay] = await Promise.all([update(), update()]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const updated = required(
      first.body?.data?.updateRelationshipType.relationshipType,
      "updated relationship type",
    );
    expect(replay.body?.data?.updateRelationshipType.relationshipType).toEqual(
      updated,
    );
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "relationshipType.update"),
          ),
        ),
    ).toHaveLength(1);

    const changed = await fixture.execute({
      jar: owner.jar,
      operationName: "UpdateRelationshipType",
      query: UpdateRelationshipTypeDocument,
      variables: { input: { ...input, inverseLabel: "changed" } },
    });
    expectGraphQLError(changed, "CONFLICT");
  });
});
