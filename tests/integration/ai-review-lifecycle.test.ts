// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import {
  aiCitations,
  aiMessages,
  aiReviewSuggestions,
  aiRuns,
  aiThreads,
} from "@/db/schema/ai";
import {
  evidenceAssertions,
  evidenceExcerpts,
  evidenceItems,
  sourceCustodyEvents,
  sources,
} from "@/db/schema/evidence";
import {
  personWebResearchRuns,
  personWebResearchSources,
} from "@/db/schema/person-research";
import { factDefinitions, facts } from "@/db/schema/facts";
import { purposePolicies } from "@/db/schema/governance";
import { people } from "@/db/schema/people";
import { sessions } from "@/db/schema/auth";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import {
  createAiReviewService,
  recordAiSuggestion,
} from "@/modules/ai/review-service";
import { sourceSnapshotHash } from "@/modules/ai/source-provenance";
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
      factDefinitionId?: string;
      personId?: string;
    } = {},
  ) {
    const field = input.factDefinitionId
      ? "fact"
      : (input.field ?? "biography");
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
          ...(input.factDefinitionId
            ? { definitionId: input.factDefinitionId }
            : {}),
          value: "Synthetic researcher",
          sourceUrls: ["https://example.org/profile"],
        },
      ],
      sourceCount: 1,
      consentedAt: new Date(),
      createdBy: context.actor.principalId,
    });
    await fixture.database.insert(personWebResearchSources).values({
      id: newId(),
      workspaceId: context.workspaceId,
      runId,
      personId: person.id,
      url: "https://example.org/profile",
      title: "Profile",
      snippet: "Synthetic public profile",
      collectionTimestamp: new Date("2026-09-13T12:00:00.000Z"),
      retrievalHash: sourceSnapshotHash({
        url: "https://example.org/profile",
        title: "Profile",
        snippet: "Synthetic public profile",
      }),
      provider: "COMPATIBLE",
      model: "synthetic",
      metadata: { fixture: "ai-review" },
    });
    if (input.factDefinitionId) {
      const [purposePolicy] = await fixture.database
        .select()
        .from(purposePolicies)
        .where(eq(purposePolicies.workspaceId, context.workspaceId));
      await createGovernanceService(context).setFieldPolicy({
        idempotencyKey: newId(),
        purposePolicyId: purposePolicy!.id,
        fieldDefinitionId: input.factDefinitionId,
        permittedScopes: ["read", "write", "ai_operation"],
        sensitivityCeiling: "internal",
      });
    }
    return recordAiSuggestion(context, {
      personId: person.id,
      fieldKey: field,
      purpose: "research",
      proposedValue: input.factDefinitionId
        ? {
            version: 1,
            kind: "fact",
            definitionId: input.factDefinitionId,
            value: { text: "Synthetic researcher" },
          }
        : {
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
  it.each(["accepted", "rejected", "deferred"] as const)(
    "durably converges concurrent %s retries with one decision audit",
    async (decision) => {
      const row = await draft();
      const service = createAiReviewService(reviewerContext);
      const input = {
        id: row.id,
        expectedVersion: row.version,
        explicitConfirmed: true,
        reason: "Reviewed evidence",
        idempotencyKey: newId(),
      };
      const invoke = () =>
        decision === "accepted"
          ? service.acceptSuggestion({
              id: input.id,
              expectedVersion: input.expectedVersion,
              explicitConfirmed: true,
              idempotencyKey: input.idempotencyKey,
            })
          : decision === "rejected"
            ? service.rejectSuggestion({
                id: input.id,
                expectedVersion: input.expectedVersion,
                reason: input.reason,
                idempotencyKey: input.idempotencyKey,
              })
            : service.deferSuggestion({
                id: input.id,
                expectedVersion: input.expectedVersion,
                idempotencyKey: input.idempotencyKey,
              });
      const [first, second] = await Promise.all([invoke(), invoke()]);
      expect(first.id).toBe(row.id);
      expect(second).toMatchObject({
        id: row.id,
        version: row.version + 1,
        status: decision,
      });
      const audit = await fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, context.workspaceId),
            eq(auditEvents.resourceId, row.id),
            eq(auditEvents.action, `ai.suggestion.${decision}`),
          ),
        );
      expect(audit).toHaveLength(1);
    },
  );
  it("binds a review key to normalized decision material", async () => {
    const row = await draft();
    const service = createAiReviewService(reviewerContext);
    const input = {
      id: row.id,
      expectedVersion: row.version,
      reason: "Reviewed",
      idempotencyKey: newId(),
    };
    await service.rejectSuggestion(input);
    await expect(
      service.rejectSuggestion({
        ...input,
        id: input.id.toUpperCase(),
        reason: " Reviewed ",
      }),
    ).resolves.toMatchObject({ id: row.id, status: "rejected" });
    await expect(
      service.rejectSuggestion({ ...input, reason: "Different reason" }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    await expect(
      service.deferSuggestion({
        id: input.id,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });
  async function reviewClaim(operation = "ai.review.decision") {
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, context.workspaceId),
          eq(locationMutationIdempotency.operation, operation),
        ),
      );
    expect(claims).toHaveLength(1);
    return claims[0]!;
  }
  it("replays only strict opaque suggestion references and rejects redirected, stale, or surplus fields", async () => {
    const row = await draft();
    const service = createAiReviewService(reviewerContext);
    const input = {
      id: row.id,
      expectedVersion: row.version,
      idempotencyKey: "opaque-decision-key",
    };
    await service.deferSuggestion(input);
    const claim = await reviewClaim();
    expect(JSON.stringify(claim)).not.toContain(input.idempotencyKey);
    expect(JSON.stringify(claim.responseReference)).not.toContain("Synthetic");
    for (const responseReference of [
      { suggestions: "{" },
      {
        suggestions: JSON.stringify([
          { id: newId(), version: 2, status: "deferred" },
        ]),
      },
      {
        suggestions: JSON.stringify([
          { id: row.id, version: 3, status: "deferred" },
        ]),
      },
      {
        suggestions: JSON.stringify([
          { id: row.id, version: 2, status: "accepted" },
        ]),
      },
      {
        suggestions: JSON.stringify([
          { id: row.id, version: 2, status: "deferred", value: "leak" },
        ]),
      },
      {
        suggestions: JSON.stringify([
          { id: row.id, version: 2, status: "deferred" },
        ]),
        biography: "leak",
      },
    ]) {
      await fixture.database
        .update(locationMutationIdempotency)
        .set({ responseReference })
        .where(eq(locationMutationIdempotency.id, claim.id));
      await expect(service.deferSuggestion(input)).rejects.toMatchObject({
        extensions: { code: "PRECONDITION_FAILED" },
      });
    }
  });
  it("expires claims without repeating a committed decision and allows one concurrent fresh takeover", async () => {
    const row = await draft();
    const service = createAiReviewService(reviewerContext);
    const input = {
      id: row.id,
      expectedVersion: row.version,
      idempotencyKey: "expiry-key",
    };
    await service.deferSuggestion(input);
    const claim = await reviewClaim();
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(locationMutationIdempotency.id, claim.id));
    await expect(service.deferSuggestion(input)).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    const next = await draft({
      personId: row.personId,
      field: "preferredName",
    });
    const fresh = { ...input, id: next.id };
    const results = await Promise.all([
      service.deferSuggestion(fresh),
      service.deferSuggestion(fresh),
    ]);
    expect(results[0]).toMatchObject({ id: next.id, version: 2 });
    expect(results[1]).toEqual(results[0]);
  });
  it("does not replay across principals or workspaces and rechecks revoked sessions", async () => {
    const row = await draft();
    const input = {
      id: row.id,
      expectedVersion: row.version,
      idempotencyKey: newId(),
    };
    await createAiReviewService(reviewerContext).deferSuggestion(input);
    await expect(
      createAiReviewService(context).deferSuggestion(input),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    const foreign = await caseContext(fixture, await fixture.createActor());
    await expect(
      createAiReviewService(foreign).deferSuggestion(input),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await fixture.database
      .delete(sessions)
      .where(eq(sessions.userId, reviewerContext.actor.id));
    await expect(
      createAiReviewService(reviewerContext).deferSuggestion(input),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
  it("does not replay a deferred decision after another current decision", async () => {
    const row = await draft();
    const service = createAiReviewService(reviewerContext);
    const input = {
      id: row.id,
      expectedVersion: row.version,
      idempotencyKey: newId(),
    };
    await service.deferSuggestion(input);
    await service.rejectSuggestion({
      id: row.id,
      expectedVersion: 2,
      reason: "Further review",
    });
    await expect(service.deferSuggestion(input)).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });
  it.each(["person", "provenance", "purpose", "acceptedEvidence"] as const)(
    "replay reauthorizes current %s visibility",
    async (kind) => {
      const row = await draft();
      const service = createAiReviewService(reviewerContext);
      const input = {
        id: row.id,
        expectedVersion: row.version,
        explicitConfirmed: true,
        idempotencyKey: newId(),
      };
      await service.acceptSuggestion(input);
      if (kind === "person")
        await fixture.database
          .update(people)
          .set({ deletedAt: new Date() })
          .where(eq(people.id, row.personId));
      if (kind === "provenance")
        await fixture.database
          .update(personWebResearchRuns)
          .set({ model: "changed-provider-provenance" })
          .where(eq(personWebResearchRuns.id, row.researchRunId));
      if (kind === "purpose")
        await fixture.database
          .update(purposePolicies)
          .set({ state: "disabled" })
          .where(eq(purposePolicies.workspaceId, context.workspaceId));
      if (kind === "acceptedEvidence")
        await fixture.database
          .update(evidenceItems)
          .set({ deletedAt: new Date() })
          .where(eq(evidenceItems.workspaceId, context.workspaceId));
      await expect(service.acceptSuggestion(input)).rejects.toThrow();
      const audits = await fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, row.id),
            eq(auditEvents.action, "ai.suggestion.accepted"),
          ),
        );
      expect(audits).toHaveLength(1);
    },
  );
  it("converges one complete batch and binds its ordered membership", async () => {
    const first = await draft();
    const second = await draft({
      personId: first.personId,
      field: "preferredName",
    });
    const service = createAiReviewService(reviewerContext);
    const input = {
      approved: true,
      suggestions: [first, second].map((r) => ({
        id: r.id,
        expectedVersion: r.version,
      })),
      idempotencyKey: newId(),
    };
    const results = await Promise.all([
      service.reviewBatch(input),
      service.reviewBatch(input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toHaveLength(2);
    expect(
      results[0].every((r) => r.status === "accepted" && r.version === 2),
    ).toBe(true);
    await reviewClaim("ai.review.batch");
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ai.suggestion.accepted"));
    expect(audits).toHaveLength(2);
    expect(await fixture.database.select().from(evidenceItems)).toHaveLength(2);
    await expect(
      service.reviewBatch({
        ...input,
        suggestions: [...input.suggestions].reverse(),
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    await expect(
      service.reviewBatch({
        ...input,
        suggestions: input.suggestions.slice(0, 1),
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });
  it("rolls back the complete keyed batch, evidence and ledger when any item is stale", async () => {
    const first = await draft();
    const second = await draft({
      personId: first.personId,
      field: "preferredName",
    });
    await expect(
      createAiReviewService(reviewerContext).reviewBatch({
        approved: true,
        idempotencyKey: newId(),
        suggestions: [
          { id: first.id, expectedVersion: 1 },
          { id: second.id, expectedVersion: 9 },
        ],
      }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    await expectPromotionArtifactsAbsent();
    const rows = await fixture.database.select().from(aiReviewSuggestions);
    expect(
      rows.every((row) => row.status === "pending" && row.version === 1),
    ).toBe(true);
    expect(
      await fixture.database
        .select()
        .from(locationMutationIdempotency)
        .where(eq(locationMutationIdempotency.operation, "ai.review.batch")),
    ).toHaveLength(0);
  });
  async function expectPromotionArtifactsAbsent() {
    const [
      promotedSources,
      promotedEvidence,
      promotedExcerpts,
      assertions,
      audits,
    ] = await Promise.all([
      fixture.database
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.workspaceId, context.workspaceId)),
      fixture.database
        .select({ id: evidenceItems.id })
        .from(evidenceItems)
        .where(eq(evidenceItems.workspaceId, context.workspaceId)),
      fixture.database
        .select({ id: evidenceExcerpts.id })
        .from(evidenceExcerpts)
        .where(eq(evidenceExcerpts.workspaceId, context.workspaceId)),
      fixture.database
        .select({ id: evidenceAssertions.id })
        .from(evidenceAssertions)
        .where(eq(evidenceAssertions.workspaceId, context.workspaceId)),
      fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, context.workspaceId),
            eq(auditEvents.action, "ai.suggestion.web_evidence.promoted"),
          ),
        ),
    ]);
    expect(promotedSources).toEqual([]);
    expect(promotedEvidence).toEqual([]);
    expect(promotedExcerpts).toEqual([]);
    expect(assertions).toEqual([]);
    expect(audits).toEqual([]);
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
    ).resolves.toMatchObject({
      id: row.id,
      status: "accepted",
      version: 2,
    });
    const replayedPromotionSources = await fixture.database
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.workspaceId, context.workspaceId));
    expect(replayedPromotionSources).toHaveLength(1);
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

  it("promotes an accepted persisted web snapshot into one field-level evidence chain", async () => {
    const row = await draft();
    const accepted = await createAiReviewService(
      reviewerContext,
    ).acceptSuggestion({
      id: row.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });

    const promotedSources = await fixture.database
      .select()
      .from(sources)
      .where(eq(sources.workspaceId, context.workspaceId));
    const promoted = promotedSources.filter(
      (source) =>
        (source.metadata as { webResearchRunId?: string }).webResearchRunId ===
        row.researchRunId,
    );
    expect(promoted).toHaveLength(1);
    const source = promoted[0]!;
    expect(source).toMatchObject({
      canonicalUrl: "https://example.org/profile",
      collectionMethod: "ai_web_research",
      extractionMethod: "persisted_snapshot",
      collectedAt: new Date("2026-09-13T12:00:00.000Z"),
      contentHash: sourceSnapshotHash({
        url: "https://example.org/profile",
        title: "Profile",
        snippet: "Synthetic public profile",
      }),
      metadata: expect.objectContaining({
        webResearchRunId: row.researchRunId,
        provider: "COMPATIBLE",
        model: "synthetic",
        purpose: "research",
        reviewerPrincipalId: reviewerContext.actor.principalId,
      }),
    });
    expect(source.metadata as Record<string, unknown>).not.toHaveProperty(
      "fixture",
    );

    const [evidence] = await fixture.database
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.sourceId, source.id));
    expect(evidence).toMatchObject({
      externalLocator: "https://example.org/profile",
      extractedText: "Synthetic public profile",
      reviewState: "accepted",
    });
    const [excerpt] = await fixture.database
      .select()
      .from(evidenceExcerpts)
      .where(eq(evidenceExcerpts.evidenceItemId, evidence!.id));
    expect(excerpt).toMatchObject({
      locator: "Profile",
      excerpt: "Synthetic public profile",
      redactionState: "clear",
    });
    const [assertion] = await fixture.database
      .select()
      .from(evidenceAssertions)
      .where(eq(evidenceAssertions.evidenceId, evidence!.id));
    expect(assertion).toMatchObject({
      resourceId: accepted.acceptedResourceId,
      resourceKind: "person",
      fieldPath: "biography",
      locator: "Profile",
      quote: "Synthetic public profile",
      role: "supports",
      reviewState: "approved",
      createdBy: reviewerContext.actor.principalId,
    });
    const [custody] = await fixture.database
      .select()
      .from(sourceCustodyEvents)
      .where(eq(sourceCustodyEvents.sourceId, source.id));
    expect(custody).toMatchObject({
      eventKind: "collected",
      occurredAt: new Date("2026-09-13T12:00:00.000Z"),
      integrityHash: source.contentHash,
      metadata: expect.objectContaining({
        webResearchRunId: row.researchRunId,
        provider: "COMPATIBLE",
        model: "synthetic",
        retrievalHash: source.contentHash,
        purpose: "research",
        reviewerPrincipalId: reviewerContext.actor.principalId,
      }),
    });
    const promotionAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ai.suggestion.web_evidence.promoted"));
    expect(promotionAudits).toHaveLength(1);
    expect(JSON.stringify(promotionAudits)).not.toContain(
      "Synthetic public profile",
    );
  });

  it("rejects a changed web snippet instead of promoting a provider-supplied replacement", async () => {
    const row = await draft();

    await expect(
      recordAiSuggestion(context, {
        personId: row.personId,
        fieldKey: "biography",
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
            quote: "Provider replacement snippet",
            locator: "Profile",
          },
        ],
        confidence: 0.5,
        uncertainty: "Synthetic identity match not independently verified",
        provider: "COMPATIBLE",
        model: "synthetic",
        researchRunId: row.researchRunId,
        runKind: "web",
        promptPolicyVersion: "synthetic-v1",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    const suggestions = await fixture.database
      .select({ id: aiReviewSuggestions.id })
      .from(aiReviewSuggestions)
      .where(eq(aiReviewSuggestions.workspaceId, context.workspaceId));
    expect(suggestions).toEqual([{ id: row.id }]);
  });

  it("redacts accepted web history when its promoted source or evidence is no longer visible", async () => {
    const row = await draft();
    await createAiReviewService(reviewerContext).acceptSuggestion({
      id: row.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });
    const [source] = await fixture.database
      .select()
      .from(sources)
      .where(eq(sources.workspaceId, context.workspaceId));
    const [evidence] = await fixture.database
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.sourceId, source!.id));
    await fixture.database
      .update(sources)
      .set({ sensitivity: "restricted" })
      .where(eq(sources.id, source!.id));
    await fixture.database
      .update(evidenceItems)
      .set({ sensitivity: "restricted" })
      .where(eq(evidenceItems.id, evidence!.id));

    const history = await createAiReviewService(
      reviewerContext,
    ).listAcceptedHistory({
      personId: row.personId,
      purpose: "research",
      first: 10,
    });
    expect(history.nodes[0]?.evidenceReferences).toEqual([
      {
        evidenceId: null,
        kind: "web",
        locator: null,
        quote: null,
        redacted: true,
        snapshotHash: null,
        url: null,
      },
    ]);
  });

  it("rolls back the promoted chain and audit when transactional index maintenance rejects it", async () => {
    const row = await draft();
    const failingReviewer = {
      ...reviewerContext,
      searchIndexMaintenance: {
        mode: "transactional" as const,
        async apply(
          _database: typeof reviewerContext.database,
          mutations: readonly {
            sourceKind: string;
          }[],
        ) {
          if (
            mutations.some(
              (mutation) => mutation.sourceKind === "evidence_item",
            )
          )
            throw new Error("promotion index failure");
        },
      },
    };
    await expect(
      createAiReviewService(failingReviewer).acceptSuggestion({
        id: row.id,
        expectedVersion: 1,
        explicitConfirmed: true,
      }),
    ).rejects.toThrow("promotion index failure");
    const [suggestion] = await fixture.database
      .select()
      .from(aiReviewSuggestions)
      .where(eq(aiReviewSuggestions.id, row.id));
    expect(suggestion?.status).toBe("pending");
    const [person] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.id, row.personId));
    expect(person?.biography).toBeNull();
    await expectPromotionArtifactsAbsent();
  });

  it("rejects acceptance-time snapshot URL and snippet tampering without promotion artifacts", async () => {
    for (const mutation of ["snippet", "url"] as const) {
      const row = await draft();
      await fixture.database.execute(
        sql`ALTER TABLE person_web_research_sources DISABLE TRIGGER person_web_research_sources_immutable`,
      );
      try {
        await fixture.database
          .update(personWebResearchSources)
          .set(
            mutation === "snippet"
              ? { snippet: "Tampered snapshot snippet" }
              : { url: "https://example.org/tampered" },
          )
          .where(eq(personWebResearchSources.runId, row.researchRunId));
      } finally {
        await fixture.database.execute(
          sql`ALTER TABLE person_web_research_sources ENABLE TRIGGER person_web_research_sources_immutable`,
        );
      }
      await expect(
        createAiReviewService(reviewerContext).acceptSuggestion({
          id: row.id,
          expectedVersion: 1,
          explicitConfirmed: true,
        }),
      ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
      await expectPromotionArtifactsAbsent();
    }
  });

  it("links an accepted web-backed fact to its value field", async () => {
    const definitionId = newId();
    await fixture.database.insert(factDefinitions).values({
      id: definitionId,
      workspaceId: context.workspaceId,
      namespace: "person",
      fieldKey: "web_role",
      label: "Web role",
      allowedValueType: "text",
      state: "active",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    const row = await draft({ factDefinitionId: definitionId });
    const accepted = await createAiReviewService(
      reviewerContext,
    ).acceptSuggestion({
      id: row.id,
      expectedVersion: 1,
      explicitConfirmed: true,
    });
    const [fact] = await fixture.database
      .select()
      .from(facts)
      .where(eq(facts.id, accepted.acceptedResourceId!));
    expect(fact).toMatchObject({
      id: accepted.acceptedResourceId,
      personId: row.personId,
      factDefinitionId: definitionId,
      valueText: "Synthetic researcher",
    });
    const [assertion] = await fixture.database
      .select()
      .from(evidenceAssertions)
      .where(eq(evidenceAssertions.resourceId, fact!.id));
    expect(assertion).toMatchObject({
      resourceKind: "fact",
      fieldPath: "value",
      purpose: "research",
    });
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
    const promotionSources = await fixture.database
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.workspaceId, context.workspaceId));
    expect(promotionSources).toEqual([]);
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
