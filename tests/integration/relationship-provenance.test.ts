// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { newId } from "@/db/id";
import { and, eq } from "drizzle-orm";
import {
  evidenceAssertions,
  evidenceItems,
  sources,
  evidenceAssertionReviews,
} from "@/db/schema/evidence";
import { relationships } from "@/db/schema/relationships";
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
  function assertion(
    input: Partial<{
      resourceId: string;
      role: "supports" | "contradicts" | "context";
    }> = {},
  ) {
    return linkEvidenceAssertion(context, {
      evidenceId,
      resourceKind: "relationship",
      resourceId: input.resourceId ?? id,
      locator: "page 1",
      quote: "A private fixture quote",
      role: input.role ?? "supports",
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
  it("defaults new relationships to hypotheses and rejects unsupported documented creation", async () => {
    const service = createRelationshipsService(context);
    const type = await service.createType({
      key: "colleague",
      forwardLabel: "colleague of",
      inverseLabel: "colleague of",
    });
    const documentedType = await service.createType({
      key: "housemate",
      forwardLabel: "housemate of",
      inverseLabel: "housemate of",
    });
    const [relationship] = await fixture.database
      .select({
        sourcePersonId: relationships.sourcePersonId,
        targetPersonId: relationships.targetPersonId,
      })
      .from(relationships)
      .where(eq(relationships.id, id));
    const { sourcePersonId, targetPersonId } = relationship!;
    const defaulted = await service.create({
      sourcePersonId,
      targetPersonId,
      relationshipTypeId: type.resource!.id,
      governancePurpose: "research",
      explicitConfirmed: true,
    });
    expect(defaulted.resource).toMatchObject({
      epistemicStatus: "analyst_hypothesis",
      reviewState: "unreviewed",
    });
    await expect(
      service.create({
        sourcePersonId,
        targetPersonId,
        relationshipTypeId: documentedType.resource!.id,
        governancePurpose: "research",
        explicitConfirmed: true,
        epistemicStatus: "documented",
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(
      await fixture.database
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          eq(relationships.relationshipTypeId, documentedType.resource!.id),
        ),
    ).toEqual([]);
  });
  it("requires a reviewed supporting assertion to document a hypothesis", async () => {
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 1,
        epistemicStatus: "documented",
        governancePurpose: "research",
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    const unreviewed = await assertion();
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 1,
        epistemicStatus: "documented",
        governancePurpose: "research",
        explicitConfirmed: true,
        evidenceAssertionId: unreviewed.id,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    await reviewEvidenceAssertion(reviewer, {
      id: unreviewed.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified source",
    });
    const promoted = await createRelationshipsService(reviewer).update({
      id,
      expectedVersion: 1,
      epistemicStatus: "documented",
      governancePurpose: "research",
      explicitConfirmed: true,
      evidenceAssertionId: unreviewed.id,
    });
    expect(promoted.resource).toMatchObject({
      epistemicStatus: "documented",
      reviewState: "approved",
      version: 2,
    });
  });
  it("allows only one concurrent documented promotion and emits one redacted audit", async () => {
    const supporting = await assertion();
    await reviewEvidenceAssertion(reviewer, {
      id: supporting.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified source",
    });
    const input = {
      id,
      expectedVersion: 1,
      epistemicStatus: "documented",
      governancePurpose: "research",
      explicitConfirmed: true,
      evidenceAssertionId: supporting.id,
    } as const;
    const outcomes = await Promise.all([
      createRelationshipsService(reviewer).update(input),
      createRelationshipsService(reviewer).update(input),
    ]);
    expect(outcomes.filter((outcome) => outcome.resource)).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.code === "CONFLICT"),
    ).toHaveLength(1);
    const audits = await fixture.database
      .select({ redactedDiff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(eq(auditEvents.action, "relationship.update"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain("A private fixture quote");
  });
  it("rejects a contradictory assertion for documentation", async () => {
    const contradicted = await assertion({ role: "contradicts" });
    await reviewEvidenceAssertion(reviewer, {
      id: contradicted.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Contradictory source",
    });
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 1,
        epistemicStatus: "documented",
        governancePurpose: "research",
        explicitConfirmed: true,
        evidenceAssertionId: contradicted.id,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });
  it("rejects an approved assertion for another relationship", async () => {
    const service = createRelationshipsService(context);
    const type = await service.createType({
      key: "coworker",
      forwardLabel: "coworker of",
      inverseLabel: "coworker of",
    });
    const [relationship] = await fixture.database
      .select({
        sourcePersonId: relationships.sourcePersonId,
        targetPersonId: relationships.targetPersonId,
      })
      .from(relationships)
      .where(eq(relationships.id, id));
    const unrelated = await service.create({
      sourcePersonId: relationship!.sourcePersonId,
      targetPersonId: relationship!.targetPersonId,
      relationshipTypeId: type.resource!.id,
      creationMethod: "ai",
      governancePurpose: "research",
      explicitConfirmed: true,
    });
    const foreign = await assertion({ resourceId: unrelated.resource!.id });
    await reviewEvidenceAssertion(reviewer, {
      id: foreign.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified unrelated relationship",
    });
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 1,
        epistemicStatus: "documented",
        governancePurpose: "research",
        explicitConfirmed: true,
        evidenceAssertionId: foreign.id,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });
  it("rejects an approval bound to a stale relationship version", async () => {
    const supporting = await assertion();
    await reviewEvidenceAssertion(reviewer, {
      id: supporting.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified source",
    });
    const intervening = await createRelationshipsService(context).update({
      id,
      expectedVersion: 1,
      state: "disputed",
      governancePurpose: "research",
    });
    expect(intervening.resource?.version).toBe(2);
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 2,
        epistemicStatus: "documented",
        governancePurpose: "research",
        explicitConfirmed: true,
        evidenceAssertionId: supporting.id,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });
  it("rechecks consent coverage before documenting a reviewed assertion", async () => {
    const supporting = await assertion();
    await reviewEvidenceAssertion(reviewer, {
      id: supporting.id,
      expectedVersion: 1,
      state: "approved",
      reason: "Verified source",
    });
    await createGovernanceService(context).withdrawConsent({
      idempotencyKey: newId(),
      id: consentId,
      expectedVersion: 1,
    });
    await expect(
      createRelationshipsService(reviewer).update({
        id,
        expectedVersion: 1,
        epistemicStatus: "documented",
        governancePurpose: "research",
        explicitConfirmed: true,
        evidenceAssertionId: supporting.id,
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
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
  it("persists a field path for field-level provenance", async () => {
    const row = await linkEvidenceAssertion(context, {
      evidenceId,
      resourceKind: "relationship",
      resourceId: id,
      fieldPath: "relationships.observedAt",
      locator: "page 1",
      quote: "A private fixture quote",
      role: "supports",
      confidence: 0.8,
      purpose: "research",
      explicitConfirmed: true,
    });

    expect(row.fieldPath).toBe("relationships.observedAt");
    const [stored] = await fixture.database
      .select({ fieldPath: evidenceAssertions.fieldPath })
      .from(evidenceAssertions)
      .where(eq(evidenceAssertions.id, row.id));
    expect(stored?.fieldPath).toBe("relationships.observedAt");
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
