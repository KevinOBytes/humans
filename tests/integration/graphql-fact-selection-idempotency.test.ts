// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auditEvents } from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import {
  CreateFactDefinitionDocument,
  CreateFactDocument,
  SelectPersonFieldDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("fact selection mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture({
      searchRuntime: {
        cursorHmacKey: "45".repeat(32),
        protectedLookupHmacKey: "43".repeat(32),
      },
    });
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function createSelectionFixture(actor: SessionActor, suffix: string) {
    const personResult = await fixture.createPerson(actor, {
      displayName: `Selection subject ${suffix}`,
    });
    const person = required(
      personResult.body?.data?.createPerson?.person,
      "selection person",
    );
    const definitionResult = await fixture.execute<{
      createFactDefinition: { factDefinition: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateFactDefinition",
      query: CreateFactDefinitionDocument,
      variables: {
        input: {
          namespace: `selection-${suffix}`,
          fieldKey: "preferred",
          label: "Preferred",
          allowedValueType: "TEXT",
          cardinality: "MANY",
          state: "ACTIVE",
        },
      },
    });
    const definitionId = required(
      definitionResult.body?.data?.createFactDefinition.factDefinition?.id,
      "selection definition",
    );
    const factResult = await fixture.execute<{
      createFact: { fact: { id: string } | null };
    }>({
      jar: actor.jar,
      operationName: "CreateFact",
      query: CreateFactDocument,
      variables: {
        input: {
          personId: person.id,
          definitionId,
          value: { text: "Alice" },
        },
      },
    });
    const factId = required(
      factResult.body?.data?.createFact.fact?.id,
      "selection fact",
    );
    return { personId: person.id, factId, namespace: `selection-${suffix}` };
  }

  function select(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{
      selectPersonField: {
        code: string | null;
        currentVersion: number | null;
        selection: {
          id: string;
          personId: string;
          factId: string;
          version: number;
        } | null;
      };
    }>({
      jar: actor.jar,
      operationName: "SelectPersonField",
      query: SelectPersonFieldDocument,
      variables: { input },
    });
  }

  it("converges concurrent selections and fences request material", async () => {
    const owner = await fixture.createActor();
    const data = await createSelectionFixture(owner, "owner");
    const input = {
      idempotencyKey: "fact-selection-replay-v1",
      personId: data.personId,
      namespace: data.namespace,
      fieldKey: "preferred",
      factId: data.factId,
      selectionReason: "Reviewed source",
    };

    const [first, replay] = await Promise.all([
      select(owner, input),
      select(owner, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const selection = required(
      first.body?.data?.selectPersonField.selection,
      "created selection",
    );
    expect(replay.body?.data?.selectPersonField.selection).toEqual(selection);

    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "fact.select"),
          ),
        ),
    ).toHaveLength(1);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "fact.select.graphql"),
        ),
      );
    expect(claims).toHaveLength(1);

    const changed = await select(owner, {
      ...input,
      selectionReason: "Changed request",
    });
    expectGraphQLError(changed, "CONFLICT");
  });

  it("allows the same raw key in a different workspace", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const ownerData = await createSelectionFixture(owner, "owner");
    const foreignData = await createSelectionFixture(foreign, "foreign");
    const key = "fact-selection-workspace-v1";
    const ownerResult = await select(owner, {
      idempotencyKey: key,
      ...ownerData,
      fieldKey: "preferred",
    });
    const foreignResult = await select(foreign, {
      idempotencyKey: key,
      ...foreignData,
      fieldKey: "preferred",
    });
    expect(ownerResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.data?.selectPersonField.selection?.id).not.toBe(
      ownerResult.body?.data?.selectPersonField.selection?.id,
    );
  });
});
