// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { SelectPersonPresentationDocument } from "@/graphql/generated/graphql";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("person presentation mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  function selectPresentation(
    actor: SessionActor,
    input: Record<string, unknown>,
  ) {
    return fixture.execute<{
      selectPersonPresentation: {
        code: string | null;
        person: { id: string; version: number } | null;
      };
    }>({
      jar: actor.jar,
      operationName: "SelectPersonPresentation",
      query: SelectPersonPresentationDocument,
      variables: { input },
    });
  }

  it("converges concurrent selections and preserves omitted-vs-null material", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Presentation subject",
    });
    const person = required(
      created.body?.data?.createPerson?.person,
      "presentation person",
    );
    const input = {
      personId: person.id,
      expectedVersion: person.version,
      idempotencyKey: "person-presentation-replay-v1",
    };
    const [first, replay] = await Promise.all([
      selectPresentation(actor, input),
      selectPresentation(actor, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const selected = required(
      first.body?.data?.selectPersonPresentation.person,
      "selected person",
    );
    expect(replay.body?.data?.selectPersonPresentation.person).toEqual(
      selected,
    );

    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "person.presentation.select"),
          ),
        ),
    ).toHaveLength(1);
    const claims = await fixture.database
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, actor.workspaceId),
          eq(idempotencyKeys.operation, "person.presentation.select"),
        ),
      );
    expect(claims).toHaveLength(1);

    const explicitNull = await selectPresentation(actor, {
      ...input,
      primaryNameId: null,
    });
    expectGraphQLError(explicitNull, "CONFLICT");
  });

  it("fences the same raw key to the caller workspace", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const [ownerPerson, foreignPerson] = await Promise.all([
      fixture.createPerson(owner, { displayName: "Owner presentation" }),
      fixture.createPerson(foreign, { displayName: "Foreign presentation" }),
    ]);
    const ownerRow = required(
      ownerPerson.body?.data?.createPerson?.person,
      "owner person",
    );
    const foreignRow = required(
      foreignPerson.body?.data?.createPerson?.person,
      "foreign person",
    );
    const key = "person-presentation-workspace-v1";
    const ownerResult = await selectPresentation(owner, {
      personId: ownerRow.id,
      expectedVersion: ownerRow.version,
      idempotencyKey: key,
    });
    const foreignResult = await selectPresentation(foreign, {
      personId: foreignRow.id,
      expectedVersion: foreignRow.version,
      idempotencyKey: key,
    });
    expect(ownerResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(
      foreignResult.body?.data?.selectPersonPresentation.person?.id,
    ).not.toBe(ownerResult.body?.data?.selectPersonPresentation.person?.id);
  });

  it("allows the same raw key for different users in one workspace", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "contributor");
    const [ownerPerson, memberPerson] = await Promise.all([
      fixture.createPerson(owner, { displayName: "Owner presentation user" }),
      fixture.createPerson(owner, { displayName: "Member presentation user" }),
    ]);
    const ownerRow = required(
      ownerPerson.body?.data?.createPerson?.person,
      "owner presentation person",
    );
    const memberRow = required(
      memberPerson.body?.data?.createPerson?.person,
      "member presentation person",
    );
    const key = "presentation-replay-key";
    const ownerResult = await selectPresentation(owner, {
      personId: ownerRow.id,
      expectedVersion: ownerRow.version,
      idempotencyKey: key,
    });
    const memberResult = await selectPresentation(member, {
      personId: memberRow.id,
      expectedVersion: memberRow.version,
      idempotencyKey: key,
    });
    expect(ownerResult.body?.errors).toBeUndefined();
    expect(memberResult.body?.errors).toBeUndefined();
    expect(
      memberResult.body?.data?.selectPersonPresentation.person?.id,
    ).not.toBe(ownerResult.body?.data?.selectPersonPresentation.person?.id);

    const claims = await fixture.database
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.workspaceId, owner.workspaceId),
          eq(idempotencyKeys.operation, "person.presentation.select"),
        ),
      );
    expect(claims).toHaveLength(2);
  });
});
