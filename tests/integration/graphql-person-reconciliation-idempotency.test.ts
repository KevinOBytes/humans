// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import {
  MergePersonDocument,
  UnmergePersonDocument,
} from "@/graphql/generated/graphql";
import {
  deriveResearchIdempotency,
  runIdempotentResearchWrite,
} from "@/modules/audit/transactions";

import { caseContext } from "../support/cases";
import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type RequestAuth = {
  apiKey?: string;
  jar?: SessionActor["jar"];
};

type PersonResult = {
  id: string;
  version: number;
};

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("person reconciliation mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function createPair(actor: SessionActor, label: string) {
    const [winnerResult, loserResult] = await Promise.all([
      fixture.createPerson(actor, { displayName: `${label} winner` }),
      fixture.createPerson(actor, { displayName: `${label} loser` }),
    ]);
    return {
      loser: required(
        loserResult.body?.data?.createPerson?.person,
        `${label} loser`,
      ),
      winner: required(
        winnerResult.body?.data?.createPerson?.person,
        `${label} winner`,
      ),
    };
  }

  function merge(auth: RequestAuth, input: Record<string, unknown>) {
    return fixture.execute<{
      mergePerson: { code: string | null; person: PersonResult | null };
    }>({
      ...auth,
      operationName: "MergePerson",
      query: MergePersonDocument,
      variables: { input },
    });
  }

  function unmerge(auth: RequestAuth, input: Record<string, unknown>) {
    return fixture.execute<{
      unmergePerson: { code: string | null; person: PersonResult | null };
    }>({
      ...auth,
      operationName: "UnmergePerson",
      query: UnmergePersonDocument,
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

  async function loserVersion(loserPersonId: string): Promise<number> {
    return required(
      (
        await fixture.database
          .select({ version: people.version })
          .from(people)
          .where(eq(people.id, loserPersonId))
      )[0]?.version,
      "loser version",
    );
  }

  it("converges keyed merge and unmerge retries with one redacted effect", async () => {
    const actor = await fixture.createActor();
    const pair = await createPair(actor, "Concurrent reconciliation");
    const mergeInput = {
      idempotencyKey: "reconcile-merge-concurrent",
      loserPersonId: pair.loser.id,
      reason: "The consented records describe the same person.",
      winnerPersonId: pair.winner.id,
    };
    const [firstMerge, mergeReplay] = await Promise.all([
      merge({ jar: actor.jar }, mergeInput),
      merge({ jar: actor.jar }, mergeInput),
    ]);
    expect(firstMerge.body?.errors).toBeUndefined();
    expect(mergeReplay.body?.errors).toBeUndefined();
    expect(mergeReplay.body?.data?.mergePerson.person).toEqual(
      firstMerge.body?.data?.mergePerson.person,
    );
    expectGraphQLError(
      await merge(
        { jar: actor.jar },
        { ...mergeInput, reason: "Changed merge rationale." },
      ),
      "CONFLICT",
    );

    const mergeClaim = await claim(actor, "person.merge");
    expect(mergeClaim.actorPrincipalId).toBe(actor.principalId);
    expect(mergeClaim.responseReference).toEqual({
      personId: pair.winner.id,
      version: pair.winner.version,
    });

    const unmergeInput = {
      expectedVersion: await loserVersion(pair.loser.id),
      idempotencyKey: "reconcile-unmerge-concurrent",
      loserPersonId: pair.loser.id,
    };
    const [firstUnmerge, unmergeReplay] = await Promise.all([
      unmerge({ jar: actor.jar }, unmergeInput),
      unmerge({ jar: actor.jar }, unmergeInput),
    ]);
    expect(firstUnmerge.body?.errors).toBeUndefined();
    expect(unmergeReplay.body?.errors).toBeUndefined();
    expect(unmergeReplay.body?.data?.unmergePerson.person).toEqual(
      firstUnmerge.body?.data?.unmergePerson.person,
    );
    expectGraphQLError(
      await unmerge(
        { jar: actor.jar },
        { ...unmergeInput, expectedVersion: unmergeInput.expectedVersion + 1 },
      ),
      "CONFLICT",
    );

    const unmergeClaim = await claim(actor, "person.unmerge");
    expect(unmergeClaim.actorPrincipalId).toBe(actor.principalId);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(
      audits.filter(({ action }) => action === "person.merge"),
    ).toHaveLength(1);
    expect(
      audits.filter(({ action }) => action === "person.unmerge"),
    ).toHaveLength(1);
    expect(JSON.stringify({ audits, mergeClaim, unmergeClaim })).not.toContain(
      "reconcile-",
    );
  });

  it("fences the same raw key across user, API-key, and workspace principals", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const apiKey = await fixture.provisionKey(owner, {
      person: ["read", "merge"],
    });
    const [userPair, apiPair, foreignPair] = await Promise.all([
      createPair(owner, "User principal"),
      createPair(owner, "API principal"),
      createPair(foreign, "Foreign principal"),
    ]);
    const idempotencyKey = "reconciliation-principal-fence";
    const [userResult, apiResult, foreignResult] = await Promise.all([
      merge(
        { jar: owner.jar },
        {
          idempotencyKey,
          loserPersonId: userPair.loser.id,
          reason: "User-reviewed duplicate.",
          winnerPersonId: userPair.winner.id,
        },
      ),
      merge(
        { apiKey: apiKey.key },
        {
          idempotencyKey,
          loserPersonId: apiPair.loser.id,
          reason: "API-key-reviewed duplicate.",
          winnerPersonId: apiPair.winner.id,
        },
      ),
      merge(
        { jar: foreign.jar },
        {
          idempotencyKey,
          loserPersonId: foreignPair.loser.id,
          reason: "Foreign-workspace reviewed duplicate.",
          winnerPersonId: foreignPair.winner.id,
        },
      ),
    ]);
    expect(userResult.body?.errors).toBeUndefined();
    expect(apiResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.errors).toBeUndefined();

    const apiUnmerge = await unmerge(
      { apiKey: apiKey.key },
      {
        expectedVersion: await loserVersion(apiPair.loser.id),
        idempotencyKey,
        loserPersonId: apiPair.loser.id,
      },
    );
    expect(apiUnmerge.body?.errors).toBeUndefined();
    expect(apiUnmerge.body?.data?.unmergePerson.person?.id).toBe(
      apiPair.loser.id,
    );

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(eq(locationMutationIdempotency.operation, "person.merge"));
    expect(claims).toHaveLength(3);
    expect(
      new Set(claims.map(({ actorPrincipalId }) => actorPrincipalId)),
    ).toHaveLength(3);
    expect(new Set(claims.map(({ workspaceId }) => workspaceId))).toHaveLength(
      2,
    );
    expect(JSON.stringify(claims)).not.toContain(idempotencyKey);
    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(eq(locationMutationIdempotency.operation, "person.unmerge")),
    ).toHaveLength(1);
  });

  it("rejects malformed and foreign-workspace reconciliation replay references", async () => {
    const actor = await fixture.createActor();
    const foreign = await fixture.createActor();
    const [pair, foreignPair] = await Promise.all([
      createPair(actor, "Local replay"),
      createPair(foreign, "Foreign replay"),
    ]);
    const input = {
      idempotencyKey: "reconciliation-reference-contract",
      loserPersonId: pair.loser.id,
      reason: "The local evidence supports a merge.",
      winnerPersonId: pair.winner.id,
    };
    expect(
      (await merge({ jar: actor.jar }, input)).body?.errors,
    ).toBeUndefined();
    const storedClaim = await claim(actor, "person.merge");

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          injected: "must-not-be-accepted",
          personId: pair.winner.id,
          version: pair.winner.version,
        },
      })
      .where(eq(locationMutationIdempotency.id, storedClaim.id));
    expectGraphQLError(
      await merge({ jar: actor.jar }, input),
      "VALIDATION_FAILED",
    );

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          personId: foreignPair.winner.id,
          version: foreignPair.winner.version,
        },
      })
      .where(eq(locationMutationIdempotency.id, storedClaim.id));
    expectGraphQLError(await merge({ jar: actor.jar }, input), "NOT_FOUND");

    const foreignResult = await merge(
      { jar: foreign.jar },
      {
        ...input,
        loserPersonId: foreignPair.loser.id,
        winnerPersonId: foreignPair.winner.id,
      },
    );
    expect(foreignResult.body?.errors).toBeUndefined();
    expect(foreignResult.body?.data?.mergePerson.person?.id).toBe(
      foreignPair.winner.id,
    );
  });

  it("serializes expired merge takeover and preserves unkeyed and failed writes", async () => {
    const actor = await fixture.createActor();
    const pair = await createPair(actor, "Expiry takeover");
    const input = {
      idempotencyKey: "reconciliation-expiry-takeover",
      loserPersonId: pair.loser.id,
      reason: "The reviewed records support one identity.",
      winnerPersonId: pair.winner.id,
    };
    expect(
      (await merge({ jar: actor.jar }, input)).body?.errors,
    ).toBeUndefined();
    const expiredClaim = await claim(actor, "person.merge");
    const mergedVersion = await loserVersion(pair.loser.id);
    expect(
      (
        await unmerge(
          { jar: actor.jar },
          { expectedVersion: mergedVersion, loserPersonId: pair.loser.id },
        )
      ).body?.errors,
    ).toBeUndefined();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, expiredClaim.id));

    const [takeover, concurrentReplay] = await Promise.all([
      merge({ jar: actor.jar }, input),
      merge({ jar: actor.jar }, input),
    ]);
    expect(takeover.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.data?.mergePerson.person).toEqual(
      takeover.body?.data?.mergePerson.person,
    );
    expect((await claim(actor, "person.merge")).id).not.toBe(expiredClaim.id);

    const staleUnmerge = await unmerge(
      { jar: actor.jar },
      {
        expectedVersion: 1,
        idempotencyKey: "reconciliation-stale-version",
        loserPersonId: pair.loser.id,
      },
    );
    expectGraphQLError(staleUnmerge, "CONFLICT");
    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(
          and(
            eq(locationMutationIdempotency.workspaceId, actor.workspaceId),
            eq(locationMutationIdempotency.operation, "person.unmerge"),
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
            eq(auditEvents.action, "person.merge"),
          ),
        ),
    ).toHaveLength(2);
  });

  it("replays unexpired legacy merge and unmerge claims without duplicate effects", async () => {
    const actor = await fixture.createActor();
    const pair = await createPair(actor, "Legacy reconciliation");
    const context = {
      ...(await caseContext(fixture, actor)),
      idempotencyHmacKey: "42".repeat(32),
    };
    const mergeInput = {
      idempotencyKey: "legacy-reconciliation-merge",
      loserPersonId: pair.loser.id,
      reason: "Legacy reviewed merge.",
      winnerPersonId: pair.winner.id,
    };
    const merged = await merge(
      { jar: actor.jar },
      { ...mergeInput, idempotencyKey: undefined },
    );
    expect(merged.body?.errors).toBeUndefined();
    await runIdempotentResearchWrite(
      context,
      deriveResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: mergeInput.idempotencyKey,
        operation: "person.merge",
        requestMaterial: {
          loserPersonId: pair.loser.id,
          reason: mergeInput.reason,
          winnerPersonId: pair.winner.id,
        },
        secret: context.idempotencyHmacKey,
      }),
      ["person:merge"],
      async () => ({ personId: pair.winner.id, version: pair.winner.version }),
    );
    expect(
      (await merge({ jar: actor.jar }, mergeInput)).body?.data?.mergePerson
        .person,
    ).toEqual(merged.body?.data?.mergePerson.person);

    const unmergeInput = {
      expectedVersion: await loserVersion(pair.loser.id),
      idempotencyKey: "legacy-reconciliation-unmerge",
      loserPersonId: pair.loser.id,
    };
    const unmerged = await unmerge(
      { jar: actor.jar },
      { ...unmergeInput, idempotencyKey: undefined },
    );
    expect(unmerged.body?.errors).toBeUndefined();
    const unmergedPerson = required(
      unmerged.body?.data?.unmergePerson.person,
      "legacy unmerged person",
    );
    await runIdempotentResearchWrite(
      context,
      deriveResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: unmergeInput.idempotencyKey,
        operation: "person.unmerge",
        requestMaterial: {
          expectedVersion: unmergeInput.expectedVersion,
          loserPersonId: pair.loser.id,
        },
        secret: context.idempotencyHmacKey,
      }),
      ["person:merge"],
      async () => ({
        personId: unmergedPerson.id,
        version: unmergedPerson.version,
      }),
    );
    expect(
      (await unmerge({ jar: actor.jar }, unmergeInput)).body?.data
        ?.unmergePerson.person,
    ).toEqual(unmergedPerson);

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
      ).map(({ operation }) => operation),
    ).toEqual(["person.merge", "person.unmerge"]);
    const audits = await fixture.database
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, actor.workspaceId));
    expect(
      audits.filter(({ action }) => action === "person.merge"),
    ).toHaveLength(1);
    expect(
      audits.filter(({ action }) => action === "person.unmerge"),
    ).toHaveLength(1);
  });
});
