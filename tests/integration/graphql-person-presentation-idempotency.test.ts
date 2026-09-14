// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { SelectPersonPresentationDocument } from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type RequestAuth = {
  apiKey?: string;
  jar?: SessionActor["jar"];
};

type PresentationPerson = {
  id: string;
  version: number;
};

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
    auth: RequestAuth,
    input: Record<string, unknown>,
  ) {
    return fixture.execute<{
      selectPersonPresentation: {
        code: string | null;
        person: PresentationPerson | null;
      };
    }>({
      ...auth,
      operationName: "SelectPersonPresentation",
      query: SelectPersonPresentationDocument,
      variables: { input },
    });
  }

  async function claim(actor: SessionActor) {
    return required(
      (
        await fixture.database
          .select()
          .from(locationMutationIdempotency)
          .where(
            and(
              eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
              eq(
                locationMutationIdempotency.actorPrincipalId,
                actor.principalId,
              ),
              eq(
                locationMutationIdempotency.operation,
                "person.presentation.select",
              ),
            ),
          )
      )[0],
      "person presentation claim",
    );
  }

  it("converges concurrent retries, rejects changed material, and records one redacted audit", async () => {
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
    const [first, concurrentReplay] = await Promise.all([
      selectPresentation({ jar: actor.jar }, input),
      selectPresentation({ jar: actor.jar }, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.errors).toBeUndefined();
    const selected = required(
      first.body?.data?.selectPersonPresentation.person,
      "selected person",
    );
    expect(
      concurrentReplay.body?.data?.selectPersonPresentation.person,
    ).toEqual(selected);
    expect(
      (await selectPresentation({ jar: actor.jar }, input)).body?.data
        ?.selectPersonPresentation.person,
    ).toEqual(selected);

    expectGraphQLError(
      await selectPresentation(
        { jar: actor.jar },
        { ...input, primaryNameId: null },
      ),
      "CONFLICT",
    );

    const storedClaim = await claim(actor);
    expect(storedClaim.responseReference).toEqual({
      personId: person.id,
      version: 2,
    });
    expect(storedClaim.actorPrincipalId).toBe(actor.principalId);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, "person.presentation.select"),
          eq(auditEvents.resourceId, person.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify({ audits, storedClaim })).not.toContain(
      input.idempotencyKey,
    );
  });

  it("rejects injected and direct foreign-workspace replay references", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const [created, foreignCreated] = await Promise.all([
      fixture.createPerson(actor, { displayName: "Local presentation" }),
      fixture.createPerson(foreign, { displayName: "Foreign presentation" }),
    ]);
    const person = required(
      created.body?.data?.createPerson?.person,
      "local presentation person",
    );
    const foreignPerson = required(
      foreignCreated.body?.data?.createPerson?.person,
      "foreign presentation person",
    );
    const input = {
      personId: person.id,
      expectedVersion: person.version,
      idempotencyKey: "person-presentation-reference-v1",
    };
    expect(
      (await selectPresentation({ jar: actor.jar }, input)).body?.errors,
    ).toBeUndefined();
    const storedClaim = await claim(actor);

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          injected: "must-not-be-accepted",
          personId: person.id,
          version: 2,
        },
      })
      .where(eq(locationMutationIdempotency.id, storedClaim.id));
    expectGraphQLError(
      await selectPresentation({ jar: actor.jar }, input),
      "VALIDATION_FAILED",
    );

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          personId: foreignPerson.id,
          version: foreignPerson.version,
        },
      })
      .where(eq(locationMutationIdempotency.id, storedClaim.id));
    expectGraphQLError(
      await selectPresentation({ jar: actor.jar }, input),
      "NOT_FOUND",
    );

    const foreignResult = await selectPresentation(
      { jar: foreign.jar },
      {
        personId: foreignPerson.id,
        expectedVersion: foreignPerson.version,
        idempotencyKey: input.idempotencyKey,
      },
    );
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.data?.selectPersonPresentation.person?.id).toBe(
      foreignPerson.id,
    );
  });

  it("serializes expired-claim takeover without duplicating the takeover audit", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Expired presentation",
    });
    const person = required(
      created.body?.data?.createPerson?.person,
      "expired presentation person",
    );
    const input = {
      personId: person.id,
      expectedVersion: person.version,
      idempotencyKey: "presentation-expiry",
    };
    expect(
      (await selectPresentation({ jar: actor.jar }, input)).body?.errors,
    ).toBeUndefined();
    const expiredClaim = await claim(actor);
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, expiredClaim.id));
    await fixture.database
      .update(people)
      .set({ version: person.version })
      .where(eq(people.id, person.id));

    const [takeover, concurrentReplay] = await Promise.all([
      selectPresentation({ jar: actor.jar }, input),
      selectPresentation({ jar: actor.jar }, input),
    ]);
    expect(takeover.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.errors).toBeUndefined();
    expect(
      concurrentReplay.body?.data?.selectPersonPresentation.person,
    ).toEqual(takeover.body?.data?.selectPersonPresentation.person);
    expect((await claim(actor)).id).not.toBe(expiredClaim.id);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "person.presentation.select"),
            eq(auditEvents.resourceId, person.id),
          ),
        ),
    ).toHaveLength(2);
  });

  it("fences the same raw key across user, API-key, and foreign-workspace principals", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const apiKey = await fixture.provisionKey(owner, {
      person: ["read", "update"],
    });
    const [userCreated, apiCreated, foreignCreated] = await Promise.all([
      fixture.createPerson(owner, { displayName: "User presentation" }),
      fixture.createPerson(owner, { displayName: "API presentation" }),
      fixture.createPerson(foreign, { displayName: "Foreign presentation" }),
    ]);
    const userPerson = required(
      userCreated.body?.data?.createPerson?.person,
      "user presentation person",
    );
    const apiPerson = required(
      apiCreated.body?.data?.createPerson?.person,
      "API presentation person",
    );
    const foreignPerson = required(
      foreignCreated.body?.data?.createPerson?.person,
      "foreign presentation person",
    );
    const idempotencyKey = "principal-fence";

    const [userResult, apiResult, foreignResult] = await Promise.all([
      selectPresentation(
        { jar: owner.jar },
        {
          personId: userPerson.id,
          expectedVersion: userPerson.version,
          idempotencyKey,
        },
      ),
      selectPresentation(
        { apiKey: apiKey.key },
        {
          personId: apiPerson.id,
          expectedVersion: apiPerson.version,
          idempotencyKey,
        },
      ),
      selectPresentation(
        { jar: foreign.jar },
        {
          personId: foreignPerson.id,
          expectedVersion: foreignPerson.version,
          idempotencyKey,
        },
      ),
    ]);
    expect(userResult.body?.errors).toBeUndefined();
    expect(apiResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(
      new Set(
        [userResult, apiResult, foreignResult].map(
          (result) => result.body?.data?.selectPersonPresentation.person?.id,
        ),
      ),
    ).toHaveLength(3);

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "person.presentation.select"),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((row) => row.actorPrincipalId))).toHaveLength(3);
    expect(JSON.stringify(claims)).not.toContain(idempotencyKey);
  });

  it("preserves unkeyed presentation updates without creating a claim", async () => {
    const actor = await fixture.createActor();
    const created = await fixture.createPerson(actor, {
      displayName: "Unkeyed presentation",
    });
    const person = required(
      created.body?.data?.createPerson?.person,
      "unkeyed presentation person",
    );
    const result = await selectPresentation(
      { jar: actor.jar },
      { personId: person.id, expectedVersion: person.version },
    );
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.selectPersonPresentation.person).toMatchObject({
      id: person.id,
      version: 2,
    });
    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(
          eq(
            locationMutationIdempotency.operation,
            "person.presentation.select",
          ),
        ),
    ).toEqual([]);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "person.presentation.select"),
            eq(auditEvents.resourceId, person.id),
          ),
        ),
    ).toHaveLength(1);
  });
});
