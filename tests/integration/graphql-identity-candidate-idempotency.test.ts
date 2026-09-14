// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { identityCandidates } from "@/db/schema/people";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import { ReviewIdentityCandidateDocument } from "@/graphql/generated/graphql";

import { expectGraphQLError, type SessionActor } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

type CandidateReview = {
  id: string;
  state: string;
  reviewReason: string | null;
  version: number;
};

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("identity-candidate review mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  async function seedCandidate(actor: SessionActor, label: string) {
    const [firstResult, secondResult] = await Promise.all([
      fixture.createPerson(actor, { displayName: `${label} first` }),
      fixture.createPerson(actor, { displayName: `${label} second` }),
    ]);
    const first = required(
      firstResult.body?.data?.createPerson?.person,
      `${label} first person`,
    );
    const second = required(
      secondResult.body?.data?.createPerson?.person,
      `${label} second person`,
    );
    const id = newId();
    await fixture.database.insert(identityCandidates).values({
      id,
      workspaceId: actor.workspaceId,
      firstPersonId: first.id,
      secondPersonId: second.id,
      matchSignals: { sharedIdentifier: true },
      score: "0.900",
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    return id;
  }

  function review(actor: SessionActor, input: Record<string, unknown>) {
    return fixture.execute<{
      reviewIdentityCandidate: CandidateReview;
    }>({
      jar: actor.jar,
      operationName: "ReviewIdentityCandidate",
      query: ReviewIdentityCandidateDocument,
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
                "person.identity-candidate.review",
              ),
            ),
          )
      )[0],
      "identity-candidate review claim",
    );
  }

  it("converges concurrent retries, rejects changed material, and records one redacted audit", async () => {
    const actor = await fixture.createActor();
    const candidateId = await seedCandidate(actor, "Concurrent candidate");
    const input = {
      id: candidateId,
      expectedVersion: 1,
      idempotencyKey: "identity-review-concurrent-v1",
      state: "ACCEPTED",
      reason: "The corroborating identifiers agree.",
    };

    const [first, concurrentReplay] = await Promise.all([
      review(actor, input),
      review(actor, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.errors).toBeUndefined();
    const reviewed = required(
      first.body?.data?.reviewIdentityCandidate,
      "reviewed candidate",
    );
    expect(concurrentReplay.body?.data?.reviewIdentityCandidate).toEqual(
      reviewed,
    );
    expect(
      (await review(actor, input)).body?.data?.reviewIdentityCandidate,
    ).toEqual(reviewed);

    expectGraphQLError(
      await review(actor, {
        ...input,
        reason: "The same key cannot change its review rationale.",
      }),
      "CONFLICT",
    );

    const storedClaim = await claim(actor);
    expect(storedClaim.responseReference).toEqual({
      identityCandidateId: candidateId,
      version: 2,
    });
    expect(storedClaim.actorPrincipalId).toBe(actor.principalId);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, actor.workspaceId),
          eq(auditEvents.action, "person.identity_candidate.review"),
          eq(auditEvents.resourceId, candidateId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify({ audits, storedClaim })).not.toContain(
      input.idempotencyKey,
    );
  });

  it("rejects a replay reference with any non-contract field", async () => {
    const actor = await fixture.createActor();
    const candidateId = await seedCandidate(actor, "Exact reference");
    const input = {
      id: candidateId,
      expectedVersion: 1,
      idempotencyKey: "identity-review-exact-reference-v1",
      state: "REJECTED",
      reason: "The records describe distinct people.",
    };
    expect((await review(actor, input)).body?.errors).toBeUndefined();

    const storedClaim = await claim(actor);
    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: {
          identityCandidateId: candidateId,
          version: 2,
          injected: "must-not-be-accepted",
        },
      })
      .where(eq(locationMutationIdempotency.id, storedClaim.id));

    expectGraphQLError(await review(actor, input), "VALIDATION_FAILED");
  });

  it("serializes an expired-claim takeover and executes the mutation only once", async () => {
    const actor = await fixture.createActor();
    const candidateId = await seedCandidate(actor, "Expired candidate");
    const input = {
      id: candidateId,
      expectedVersion: 1,
      idempotencyKey: "identity-review-expiry-v1",
      state: "ACCEPTED",
      reason: "The current evidence supports one identity.",
    };
    expect((await review(actor, input)).body?.errors).toBeUndefined();
    const expiredClaim = await claim(actor);

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, expiredClaim.id));
    await fixture.database
      .update(identityCandidates)
      .set({
        state: "pending",
        reviewReason: null,
        reviewedAt: null,
        reviewedBy: null,
        version: 1,
      })
      .where(eq(identityCandidates.id, candidateId));

    const [takeover, concurrentReplay] = await Promise.all([
      review(actor, input),
      review(actor, input),
    ]);
    expect(takeover.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.errors).toBeUndefined();
    expect(concurrentReplay.body?.data?.reviewIdentityCandidate).toEqual(
      takeover.body?.data?.reviewIdentityCandidate,
    );
    expect((await claim(actor)).id).not.toBe(expiredClaim.id);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "person.identity_candidate.review"),
            eq(auditEvents.resourceId, candidateId),
          ),
        ),
    ).toHaveLength(2);
  });

  it("fences the same raw key by principal and workspace", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "contributor");
    const foreign = await fixture.createActor();
    const [ownerCandidateId, memberCandidateId, foreignCandidateId] =
      await Promise.all([
        seedCandidate(owner, "Owner candidate"),
        seedCandidate(member, "Member candidate"),
        seedCandidate(foreign, "Foreign candidate"),
      ]);
    const idempotencyKey = "identity-review-principal-fence-v1";

    const [ownerReview, memberReview, foreignReview] = await Promise.all([
      review(owner, {
        id: ownerCandidateId,
        expectedVersion: 1,
        idempotencyKey,
        state: "ACCEPTED",
      }),
      review(member, {
        id: memberCandidateId,
        expectedVersion: 1,
        idempotencyKey,
        state: "ACCEPTED",
      }),
      review(foreign, {
        id: foreignCandidateId,
        expectedVersion: 1,
        idempotencyKey,
        state: "ACCEPTED",
      }),
    ]);
    expect(ownerReview.body?.errors).toBeUndefined();
    expect(memberReview.body?.errors).toBeUndefined();
    expect(foreignReview.body?.errors).toBeUndefined();
    expect(
      new Set(
        [ownerReview, memberReview, foreignReview].map(
          (result) => result.body?.data?.reviewIdentityCandidate.id,
        ),
      ),
    ).toHaveLength(3);

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(
          locationMutationIdempotency.operation,
          "person.identity-candidate.review",
        ),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((row) => row.actorPrincipalId))).toEqual(
      new Set([owner.principalId, member.principalId, foreign.principalId]),
    );
    expect(JSON.stringify(claims)).not.toContain(idempotencyKey);
  });

  it("preserves the legacy unkeyed review path without creating a claim", async () => {
    const actor = await fixture.createActor();
    const candidateId = await seedCandidate(actor, "Legacy candidate");
    const result = await review(actor, {
      id: candidateId,
      expectedVersion: 1,
      state: "REVIEWING",
      reason: "An analyst is checking the source records.",
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data?.reviewIdentityCandidate).toMatchObject({
      id: candidateId,
      state: "REVIEWING",
      version: 2,
    });
    expect(
      await fixture.database
        .select({ id: locationMutationIdempotency.id })
        .from(locationMutationIdempotency)
        .where(
          eq(
            locationMutationIdempotency.operation,
            "person.identity-candidate.review",
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
            eq(auditEvents.action, "person.identity_candidate.review"),
            eq(auditEvents.resourceId, candidateId),
          ),
        ),
    ).toHaveLength(1);
  });
});
