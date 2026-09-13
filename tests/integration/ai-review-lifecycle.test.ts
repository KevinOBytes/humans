// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@/db/id";
import {
  aiCitations,
  aiMessages,
  aiReviewSuggestions,
  aiRuns,
  aiThreads,
} from "@/db/schema/ai";
import { evidenceItems, sources } from "@/db/schema/evidence";
import { personWebResearchRuns } from "@/db/schema/person-research";
import { people } from "@/db/schema/people";
import { auditEvents } from "@/db/schema/operations";
import {
  createAiReviewService,
  recordAiSuggestion,
} from "@/modules/ai/review-service";
import { createGovernanceService } from "@/modules/governance/service";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";
const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe("AI suggestion lifecycle and provenance", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let reviewerContext: ResearchServiceContext;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    const owner = await fixture.createActor();
    context = await caseContext(fixture, owner);
    const reviewer = await fixture.createWorkspaceMember(owner, "admin");
    const baseReviewer = await caseContext(fixture, reviewer);
    if (baseReviewer.actor.type !== "user") throw new Error("user expected");
    reviewerContext = {
      ...baseReviewer,
      actor: { ...baseReviewer.actor, role: "admin" },
      permissions: new Set(rolePermissionKeys("admin")),
    };
  });
  afterAll(async () => fixture.close());
  async function draft(
    input: {
      field?: "biography" | "displayName" | "preferredName";
      personId?: string;
    } = {},
  ) {
    const field = input.field ?? "biography";
    const person = input.personId
      ? { id: input.personId }
      : await coveredPerson(context);
    await createGovernanceService(context).recordConsent({
      idempotencyKey: newId(),
      personId: person.id,
      purpose: "research",
      scopes: ["read", "write", "ai_operation"],
      lawfulBasis: "consent",
      effectiveFrom: new Date(Date.now() - 60000),
    });
    const runId = newId();
    await fixture.database.insert(personWebResearchRuns).values({
      id: runId,
      workspaceId: context.workspaceId,
      personId: person.id,
      provider: "COMPATIBLE",
      model: "synthetic",
      queryHash: "a1".repeat(32),
      governancePurpose: "research",
      sources: [
        {
          url: "https://example.org/profile",
          title: "Profile",
          snippet: "Synthetic public profile",
        },
      ],
      suggestions: [
        {
          field,
          value: "Synthetic researcher",
          sourceUrls: ["https://example.org/profile"],
        },
      ],
      sourceCount: 1,
      consentedAt: new Date(),
      createdBy: context.actor.principalId,
    });
    return recordAiSuggestion(context, {
      personId: person.id,
      fieldKey: field,
      purpose: "research",
      proposedValue: {
        version: 1,
        kind: "profile",
        value: "Synthetic researcher",
      },
      evidenceReferences: [
        {
          kind: "web",
          url: "https://example.org/profile",
          quote: "Synthetic public profile",
          locator: "Profile",
        },
      ],
      confidence: 0.5,
      uncertainty: "Synthetic identity match not independently verified",
      provider: "COMPATIBLE",
      model: "synthetic",
      researchRunId: runId,
      runKind: "web",
      promptPolicyVersion: "synthetic-v1",
    });
  }
  it("accepts one field and retains the immutable original provenance with a redacted audit", async () => {
    const row = await draft();
    const service = createAiReviewService(reviewerContext);
    const accepted = await service.acceptSuggestion({
      id: row.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      acceptedResourceId: row.personId,
      acceptedResourceKind: "person",
      reviewedBy: reviewerContext.actor.principalId,
      researchRunId: row.researchRunId,
      proposedValue: row.proposedValue,
      evidenceReferences: row.evidenceReferences,
    });
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.id, row.personId));
    expect(person).toMatchObject({
      biography: "Synthetic researcher",
      displayName: "Case fixture person",
    });
    await expect(
      service.acceptSuggestion({
        id: row.id,
        expectedVersion: 1,
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    await expect(
      fixture.database
        .update(aiReviewSuggestions)
        .set({
          proposedValue: { version: 1, kind: "profile", value: "Tampered" },
        })
        .where(eq(aiReviewSuggestions.id, row.id)),
    ).rejects.toThrow();
    const events = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, row.id));
    expect(events.map((e) => e.action)).toContain("ai.suggestion.accepted");
    expect(JSON.stringify(events)).not.toContain("Synthetic researcher");
  });
  it("defers then rejects with a reason without changing the target", async () => {
    const row = await draft();
    const service = createAiReviewService(reviewerContext);
    expect(
      (await service.deferSuggestion({ id: row.id, expectedVersion: 1 }))
        .status,
    ).toBe("deferred");
    expect(
      (
        await service.rejectSuggestion({
          id: row.id,
          expectedVersion: 2,
          reason: "Wrong identity",
        })
      ).decisionReason,
    ).toBe("Wrong identity");
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.id, row.personId));
    expect(person?.biography).toBeNull();
  });
  it("denies foreign workspaces and withdrawn AI coverage", async () => {
    const row = await draft();
    const foreign = await caseContext(fixture, await fixture.createActor());
    await expect(
      createAiReviewService(foreign).getSuggestion(row.id),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await createGovernanceService(context).recordConsent({
      idempotencyKey: newId(),
      personId: row.personId,
      purpose: "research",
      scopes: ["read", "write"],
      lawfulBasis: "consent",
      effectiveFrom: new Date(Date.now() - 1000),
    });
    await expect(
      createAiReviewService(context).acceptSuggestion({
        id: row.id,
        expectedVersion: 1,
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
  it("does not allow the suggestion author to approve their own work", async () => {
    const row = await draft();
    await expect(
      createAiReviewService(context).acceptSuggestion({
        id: row.id,
        expectedVersion: 1,
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
  it("rolls back the whole explicitly approved batch on a stale suggestion", async () => {
    const first = await draft();
    const second = await draft({ field: "displayName" });
    await expect(
      createAiReviewService(reviewerContext).reviewBatch({
        approved: true,
        suggestions: [
          { id: first.id, expectedVersion: 1 },
          { id: second.id, expectedVersion: 9 },
        ],
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    const [row] = await fixture.database
      .select()
      .from(aiReviewSuggestions)
      .where(eq(aiReviewSuggestions.id, first.id));
    expect(row?.status).toBe("pending");
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.id, first.personId));
    expect(person?.biography).toBeNull();
  });

  it("returns only accepted suggestions for the exact person and purpose in bounded pages", async () => {
    const first = await draft();
    const second = await draft({
      field: "displayName",
      personId: first.personId,
    });
    const pending = await draft({
      field: "preferredName",
      personId: first.personId,
    });
    const service = createAiReviewService(reviewerContext);
    for (const suggestion of [first, second]) {
      await service.acceptSuggestion({
        id: suggestion.id,
        expectedVersion: 1,
        explicitConfirmed: true,
      });
    }

    const pageOne = await service.listAcceptedHistory({
      personId: first.personId,
      purpose: "research",
      first: 1,
    });
    expect(pageOne.nodes).toHaveLength(1);
    expect(pageOne.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: true,
    });
    expect(pageOne.nodes[0]).toMatchObject({
      acceptedResource: {
        id: first.personId,
        kind: "person",
        redacted: false,
      },
      evidenceReferences: [
        {
          kind: "web",
          redacted: false,
          url: "https://example.org/profile",
        },
      ],
      provider: "COMPATIBLE",
      model: "synthetic",
      purpose: "research",
      researchRunId: expect.any(String),
      reviewerPrincipalId: reviewerContext.actor.principalId,
    });
    expect(pageOne.nodes[0]).not.toHaveProperty("proposedValue");

    const pageTwo = await service.listAcceptedHistory({
      personId: first.personId,
      purpose: "research",
      first: 1,
      after: pageOne.pageInfo.endCursor,
    });
    expect(pageTwo.nodes).toHaveLength(1);
    expect(pageTwo.pageInfo).toEqual({
      endCursor: expect.any(String),
      hasNextPage: false,
    });
    expect(
      new Set([...pageOne.nodes, ...pageTwo.nodes].map((row) => row.id)),
    ).toEqual(new Set([first.id, second.id]));
    expect(
      [...pageOne.nodes, ...pageTwo.nodes].map((row) => row.id),
    ).not.toContain(pending.id);

    const governance = createGovernanceService(context);
    await governance.createPurposePolicy({
      idempotencyKey: newId(),
      purpose: "archive-review",
      lawfulBases: ["consent"],
      effectiveFrom: new Date(Date.now() - 60_000),
      state: "active",
    });
    await governance.recordConsent({
      idempotencyKey: newId(),
      personId: first.personId,
      purpose: "archive-review",
      scopes: ["read", "ai_operation"],
      lawfulBasis: "consent",
      effectiveFrom: new Date(Date.now() - 60_000),
    });
    await expect(
      service.listAcceptedHistory({
        personId: first.personId,
        purpose: "archive-review",
        first: 10,
      }),
    ).resolves.toEqual({
      nodes: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    });
  });

  it("denies accepted history for a person in another workspace", async () => {
    const row = await draft();
    await createAiReviewService(reviewerContext).acceptSuggestion({
      id: row.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });
    const foreign = await caseContext(fixture, await fixture.createActor());
    await expect(
      createAiReviewService(foreign).listAcceptedHistory({
        personId: row.personId,
        purpose: "research",
        first: 10,
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });

  it("redacts accepted workspace evidence that is no longer visible", async () => {
    const person = await coveredPerson(context);
    await createGovernanceService(context).recordConsent({
      idempotencyKey: newId(),
      personId: person.id,
      purpose: "research",
      scopes: ["read", "write", "ai_operation"],
      lawfulBasis: "consent",
      effectiveFrom: new Date(Date.now() - 60_000),
    });
    const sourceId = newId();
    const evidenceId = newId();
    const threadId = newId();
    const messageId = newId();
    const aiRunId = newId();
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: context.workspaceId,
      kind: "document",
      title: "Accepted history fixture",
      sensitivity: "internal",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      sourceId,
      checksum: `sha256:${"ab".repeat(32)}`,
      reviewState: "accepted",
      sensitivity: "internal",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(aiThreads).values({
      id: threadId,
      workspaceId: context.workspaceId,
      ownerId: context.actor.principalId,
      title: "Accepted history fixture",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(aiMessages).values({
      id: messageId,
      workspaceId: context.workspaceId,
      threadId,
      role: "user",
      encryptedContent: "sealed-fixture",
      contentHash: "cd".repeat(32),
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(aiRuns).values({
      id: aiRunId,
      workspaceId: context.workspaceId,
      threadId,
      messageId,
      governancePurpose: "research",
      reviewPersonIds: [person.id],
      provider: "COMPATIBLE",
      baseUrlFingerprint: "de".repeat(32),
      model: "synthetic",
      promptHash: "ef".repeat(32),
      configurationHash: "fa".repeat(32),
      state: "completed",
      startedAt: new Date(Date.now() - 1_000),
      completedAt: new Date(),
      createdBy: context.actor.principalId,
    });
    await fixture.database.insert(aiCitations).values({
      id: newId(),
      workspaceId: context.workspaceId,
      threadId,
      aiRunId,
      messageId,
      resourceKind: "evidence",
      resourceId: evidenceId,
      evidenceItemId: evidenceId,
      locator: "page 1",
      claimText: "Sensitive accepted evidence excerpt",
    });
    const suggestion = await recordAiSuggestion(context, {
      personId: person.id,
      fieldKey: "biography",
      purpose: "research",
      proposedValue: {
        version: 1,
        kind: "profile",
        value: "Evidence-backed biography",
      },
      evidenceReferences: [
        {
          kind: "evidence",
          evidenceId,
          quote: "Sensitive accepted evidence excerpt",
          locator: "page 1",
        },
      ],
      confidence: 0.8,
      uncertainty: "Synthetic fixture uncertainty",
      provider: "COMPATIBLE",
      model: "synthetic",
      researchRunId: aiRunId,
      runKind: "analysis",
      promptPolicyVersion: "synthetic-v1",
    });
    await createAiReviewService(reviewerContext).acceptSuggestion({
      id: suggestion.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });
    await fixture.database
      .update(evidenceItems)
      .set({ sensitivity: "restricted" })
      .where(eq(evidenceItems.id, evidenceId));
    await fixture.database
      .update(sources)
      .set({ sensitivity: "restricted" })
      .where(eq(sources.id, sourceId));

    const history = await createAiReviewService(
      reviewerContext,
    ).listAcceptedHistory({
      personId: person.id,
      purpose: "research",
      first: 10,
    });
    expect(history.nodes).toHaveLength(1);
    expect(history.nodes[0]?.evidenceReferences).toEqual([
      {
        evidenceId: null,
        kind: "evidence",
        locator: null,
        quote: null,
        redacted: true,
        snapshotHash: null,
        url: null,
      },
    ]);
    expect(JSON.stringify(history)).not.toContain(
      "Sensitive accepted evidence excerpt",
    );
  });
});
