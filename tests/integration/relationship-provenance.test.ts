// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { newId } from "@/db/id";
import { and, eq } from "drizzle-orm";
import {
  evidenceItems,
  sources,
  evidenceAssertionReviews,
} from "@/db/schema/evidence";
import { auditEvents } from "@/db/schema/operations";
import { createRelationshipsService } from "@/modules/relationships/service";
import {
  linkEvidenceAssertion,
  reviewEvidenceAssertion,
} from "@/modules/evidence/assertions";
import { createGovernanceService } from "@/modules/governance/service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe("relationship evidence review and promotion", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let reviewer: ResearchServiceContext;
  let id: string;
  let evidenceId: string;
  let consentId: string;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    const actor = await fixture.createActor();
    context = await caseContext(fixture, actor);
    const reviewerActor = await fixture.createWorkspaceMember(actor, "admin");
    const reviewerContext = await caseContext(fixture, reviewerActor);
    // The fixture helper defaults service contexts to owner for the common
    // owner path. This reviewer is an administrator in the database, so the
    // live-authority/idempotency check must see the same role and permission
    // set as the persisted membership.
    reviewer = {
      ...reviewerContext,
      actor: {
        ...(reviewerContext.actor as Extract<
          ResearchServiceContext["actor"],
          { type: "user" }
        >),
        role: "admin",
      },
      permissions: new Set(rolePermissionKeys("admin")),
    };
    const first = await coveredPerson(context);
    const second = await coveredPerson(context, { policy: false });
    consentId = first.consentId;
    const service = createRelationshipsService(context);
    const type = await service.createType({
      key: "knows",
      forwardLabel: "knows",
      inverseLabel: "known by",
    });
    const relationship = await service.create({
      sourcePersonId: first.id,
      targetPersonId: second.id,
      relationshipTypeId: type.resource!.id,
      state: "inferred",
      creationMethod: "ai",
      governancePurpose: "research",
      explicitConfirmed: true,
    });
    id = relationship.resource!.id;
    const sourceId = newId();
    evidenceId = newId();
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: context.workspaceId,
      kind: "document",
      title: "Reviewed source",
      reliability: "0.800",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      sourceId,
      checksum: "fixture",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
  });
  afterAll(async () => fixture.close());
  function assertion() {
    return linkEvidenceAssertion(context, {
      evidenceId,
      resourceKind: "relationship",
      resourceId: id,
      locator: "page 1",
      quote: "A private fixture quote",
      role: "supports",
      confidence: 0.8,
      purpose: "research",
      explicitConfirmed: true,
    });
  }
  it("rejects inferred promotion without reviewed evidence", async () => {
    await expect(
      createRelationshipsService(context).update({
        id,
        expectedVersion: 1,
        state: "asserted",
        governancePurpose: "research",
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });
  it("records provenance and redacts quote/locator from audit", async () => {
    const row = await assertion();
    expect(row).toMatchObject({
      version: 1,
      reviewState: "unreviewed",
      sourceReliability: "0.800",
      informationCredibility: "0.800",
    });
    const [event] = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, row.auditReference));
    expect(JSON.stringify(event)).not.toContain("A private fixture quote");
    expect(JSON.stringify(event)).not.toContain("page 1");
  });
  it("replays assertion link and independent review without duplicate effects", async () => {
    const input = {
      evidenceId,
      resourceKind: "relationship",
      resourceId: id,
      locator: "page 1",
      quote: "A private fixture quote",
      role: "supports",
      confidence: 0.8,
      purpose: "research",
      explicitConfirmed: true,
      idempotencyKey: "assertion-link-replay-v1",
    } as const;
    const [first, replay] = await Promise.all([
      linkEvidenceAssertion(context, input),
      linkEvidenceAssertion(context, input),
    ]);
    expect(replay).toEqual(first);
    await expect(
      linkEvidenceAssertion(context, { ...input, quote: "Changed material" }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.action, "evidence.assertion.link")),
    ).toHaveLength(1);

    const reviewInput = {
      id: first.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified source",
      idempotencyKey: "assertion-review-replay-v1",
    } as const;
    const [reviewed, reviewReplay] = await Promise.all([
      reviewEvidenceAssertion(reviewer, reviewInput),
      reviewEvidenceAssertion(reviewer, reviewInput),
    ]);
    expect(reviewReplay).toEqual(reviewed);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.action, "evidence.assertion.review")),
    ).toHaveLength(1);
  });
  it("requires independent review and promotes using a version-bound approval", async () => {
    const row = await assertion();
    await expect(
      reviewEvidenceAssertion(context, {
        id: row.id,
        expectedVersion: 1,
        state: "approved",
        reason: "Verified source",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const reviewed = await reviewEvidenceAssertion(reviewer, {
      id: row.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified source",
    });
    expect(reviewed.version).toBe(2);
    const approvals = await fixture.database
      .select()
      .from(evidenceAssertionReviews)
      .where(
        and(
          eq(evidenceAssertionReviews.workspaceId, context.workspaceId),
          eq(evidenceAssertionReviews.assertionId, row.id),
        ),
      );
    expect(approvals).toHaveLength(1);
    const promoted = await createRelationshipsService(reviewer).update({
      id,
      expectedVersion: 1,
      state: "asserted",
      governancePurpose: "research",
      explicitConfirmed: true,
      evidenceAssertionId: row.id,
    });
    expect(promoted.resource).toMatchObject({
      state: "asserted",
      reviewState: "approved",
      creationMethod: "ai",
      version: 2,
    });
  });
  it("withdrawal blocks assertions and review after creation", async () => {
    const row = await assertion();
    await createGovernanceService(context).withdrawConsent({
      idempotencyKey: newId(),
      id: consentId,
      expectedVersion: 1,
    });
    await expect(assertion()).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    await expect(
      reviewEvidenceAssertion(reviewer, {
        id: row.id,
        expectedVersion: 1,
        state: "approved",
        reason: "Verified",
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
  it("keeps inference review requirements after an intervening dispute", async () => {
    const disputed = await createRelationshipsService(context).update({
      id,
      expectedVersion: 1,
      state: "disputed",
      governancePurpose: "research",
    });
    expect(disputed.resource).toMatchObject({
      state: "disputed",
      reviewState: "unreviewed",
      version: 2,
    });
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 2,
        state: "corroborated",
        governancePurpose: "research",
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    const row = await assertion();
    await reviewEvidenceAssertion(reviewer, {
      id: row.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Dispute resolved from the source",
    });
    const reviewed = await createRelationshipsService(reviewer).update({
      id,
      expectedVersion: 2,
      state: "corroborated",
      governancePurpose: "research",
      explicitConfirmed: true,
      evidenceAssertionId: row.id,
    });
    expect(reviewed.resource).toMatchObject({
      state: "corroborated",
      reviewState: "approved",
      version: 3,
    });
  });
});
