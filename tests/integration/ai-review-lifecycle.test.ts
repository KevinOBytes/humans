// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { aiReviewSuggestions } from "@/db/schema/ai";
import { personWebResearchRuns } from "@/db/schema/person-research";
import { people } from "@/db/schema/people";
import { auditEvents } from "@/db/schema/operations";
import {
  createAiReviewService,
  recordAiSuggestion,
} from "@/modules/ai/review-service";
import { createGovernanceService } from "@/modules/governance/service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";
const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe("AI suggestion lifecycle and provenance", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    context = await caseContext(fixture, await fixture.createActor());
  });
  afterAll(async () => fixture.close());
  async function draft(field = "biography") {
    const person = await coveredPerson(context);
    await createGovernanceService(context).recordConsent({
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
    const service = createAiReviewService(context);
    const accepted = await service.acceptSuggestion({
      id: row.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      acceptedResourceId: row.personId,
      acceptedResourceKind: "person",
      reviewedBy: context.actor.principalId,
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
    const service = createAiReviewService(context);
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
  it("rolls back the whole explicitly approved batch on a stale suggestion", async () => {
    const first = await draft();
    const second = await draft("displayName");
    await expect(
      createAiReviewService(context).reviewBatch({
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
});
