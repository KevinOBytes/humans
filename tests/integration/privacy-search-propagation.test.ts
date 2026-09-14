// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@/db/id";
import { evidenceExcerpts, evidenceItems, sources } from "@/db/schema/evidence";
import { files } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import {
  deletionRequests,
  privacyProcessorPropagations,
} from "@/db/schema/privacy";
import { relationships, relationshipTypes } from "@/db/schema/relationships";
import { searchDocuments } from "@/db/schema/search";
import { createPrivacyRequestService } from "@/modules/privacy/request-service";
import {
  createCachePrivacyProcessorAdapter,
  createSearchPrivacyProcessorAdapter,
  executePrivacyPropagations,
} from "@/modules/privacy/propagation-worker";
import type { PrivacyRequestRow } from "@/modules/privacy/request-types";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";

const live = process.env.TEST_DATABASE_URL ? describe : describe.skip;

live("privacy search propagation", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let reviewer: ResearchServiceContext;
  let evidenceId: string;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });

  beforeEach(async () => {
    await fixture.reset();
    const actor = await fixture.createActor();
    context = await caseContext(fixture, actor);
    const reviewerActor = await fixture.createWorkspaceMember(actor, "admin");
    reviewer = await caseContext(fixture, reviewerActor);
    reviewer.actor = {
      ...reviewer.actor,
      role: "admin",
    } as typeof reviewer.actor;
    evidenceId = newId();
    await fixture.database.insert(files).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      storageProvider: "s3",
      storageBucket: "test",
      storageKey: evidenceId,
      originalName: "verification.txt",
      byteSize: 1,
      checksum: "a".repeat(64),
      quarantineState: "available",
      scanState: "clean",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
  });

  afterAll(async () => fixture.close());

  async function insertDocument(input: {
    workspaceId: string;
    resourceKind:
      "person" | "note" | "relationship" | "evidence_item" | "evidence_excerpt";
    resourceId: string;
    resultId: string;
    subjectPersonId?: string | null;
  }) {
    await fixture.database.insert(searchDocuments).values({
      id: newId(),
      workspaceId: input.workspaceId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      sourceVersion: 1,
      chunkOrdinal: 0,
      resultKind:
        input.resourceKind === "person"
          ? "PERSON"
          : input.resourceKind === "relationship"
            ? "RELATIONSHIP"
            : "EVIDENCE",
      resultId: input.resultId,
      subjectPersonId: input.subjectPersonId ?? null,
      sensitivity: "internal",
      documentSchemaVersion: 1,
      redactedText: `${input.resourceKind} ${input.resourceId}`,
      bodyText: "",
      displayText: `${input.resourceKind} ${input.resourceId}`,
      updatedAt: new Date(),
    });
  }

  async function fulfillRequest(
    personIds: string[],
    requestType: "correction" | "restriction" | "deletion",
    fileIds: string[] = [],
  ) {
    const request = await createPrivacyRequestService(context).createRequest({
      requestType,
      personIds,
      fileIds,
      ...(requestType === "restriction" ? { purpose: "research" } : {}),
      dueAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: newId(),
    });
    const service = createPrivacyRequestService(reviewer);
    const approved = await service.reviewRequest({
      id: request.id,
      expectedVersion: 1,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    const fulfilled = await service.fulfillRequest({
      id: request.id,
      expectedVersion: approved.version,
    });
    if (fulfilled.legacyDeletionRequestId)
      await fixture.database
        .update(deletionRequests)
        .set({ state: "completed", completedAt: new Date() })
        .where(eq(deletionRequests.id, fulfilled.legacyDeletionRequestId));
    return fulfilled;
  }

  it("purges direct and dependent documents without crossing workspace boundaries", async () => {
    const person = await coveredPerson(context);
    const unrelated = await coveredPerson(context);
    const foreignContext = await caseContext(
      fixture,
      await fixture.createActor(),
    );
    const foreignPerson = await coveredPerson(foreignContext);
    const relationshipTypeId = newId();
    await fixture.database.insert(relationshipTypes).values({
      id: relationshipTypeId,
      workspaceId: context.workspaceId,
      key: "knows",
      forwardLabel: "knows",
      inverseLabel: "known by",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    const relationshipId = newId();
    await fixture.database.insert(relationships).values({
      id: relationshipId,
      workspaceId: context.workspaceId,
      sourcePersonId: unrelated.id,
      targetPersonId: person.id,
      relationshipTypeId,
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });

    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "person",
      resourceId: person.id,
      resultId: person.id,
    });
    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "note",
      resourceId: newId(),
      resultId: person.id,
      subjectPersonId: person.id,
    });
    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "relationship",
      resourceId: relationshipId,
      resultId: relationshipId,
      subjectPersonId: unrelated.id,
    });
    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "person",
      resourceId: unrelated.id,
      resultId: unrelated.id,
    });
    await insertDocument({
      workspaceId: foreignContext.workspaceId,
      resourceKind: "person",
      resourceId: foreignPerson.id,
      resultId: foreignPerson.id,
    });

    const request = await fulfillRequest([person.id], "restriction");
    await executePrivacyPropagations({
      adapters: {
        cache: createCachePrivacyProcessorAdapter(),
        search: createSearchPrivacyProcessorAdapter(),
      },
      database: fixture.database,
      now: new Date(Date.now() + 1_000),
    });
    const retry = await createSearchPrivacyProcessorAdapter()({
      database: fixture.database,
      request,
      idempotencyKey: request.id,
    });
    expect(retry).toEqual({
      state: "succeeded",
      evidenceReference: `search-purge:${request.id}`,
    });

    const remaining = await fixture.database
      .select({
        workspaceId: searchDocuments.workspaceId,
        resourceId: searchDocuments.resourceId,
      })
      .from(searchDocuments)
      .where(
        and(
          inArray(searchDocuments.resourceId, [
            person.id,
            unrelated.id,
            foreignPerson.id,
            relationshipId,
          ]),
        ),
      );
    expect(remaining).toHaveLength(2);
    expect(remaining).toEqual(
      expect.arrayContaining([
        { workspaceId: context.workspaceId, resourceId: unrelated.id },
        {
          workspaceId: foreignContext.workspaceId,
          resourceId: foreignPerson.id,
        },
      ]),
    );

    const propagationRows = await fixture.database
      .select()
      .from(privacyProcessorPropagations)
      .where(eq(privacyProcessorPropagations.privacyRequestId, request.id));
    expect(
      propagationRows.find((row) => row.processor === "search"),
    ).toMatchObject({
      state: "succeeded",
      resultCode: "evidence_recorded",
      evidenceReference: `search-purge:${request.id}`,
    });
    expect(
      propagationRows.find((row) => row.processor === "cache"),
    ).toMatchObject({
      state: "not_applicable",
      resultCode: "evidence_recorded",
      evidenceReference: "cache:not-applicable:operational-only",
    });
    expect(
      propagationRows.find((row) => row.processor === "email"),
    ).toMatchObject({ state: "failed", resultCode: "processor_unconfigured" });
    expect(
      propagationRows.find((row) => row.processor === "ai_provider"),
    ).toMatchObject({ state: "failed", resultCode: "processor_unconfigured" });

    const searchAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, request.id),
          eq(auditEvents.action, "privacy.processor.result"),
        ),
      );
    expect(
      searchAudits.filter(
        (audit) =>
          (audit.redactedDiff as { processor?: string }).processor === "search",
      ),
    ).toHaveLength(1);
  });

  it("fails closed for correction until a safe reindex path is available", async () => {
    const person = await coveredPerson(context);
    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "person",
      resourceId: person.id,
      resultId: person.id,
    });

    const request = await fulfillRequest([person.id], "correction");
    await executePrivacyPropagations({
      adapters: {
        cache: createCachePrivacyProcessorAdapter(),
        search: createSearchPrivacyProcessorAdapter(),
      },
      database: fixture.database,
      now: new Date(Date.now() + 1_000),
    });

    expect(
      await fixture.database
        .select({ id: searchDocuments.id })
        .from(searchDocuments)
        .where(eq(searchDocuments.resourceId, person.id)),
    ).toHaveLength(1);
    expect(
      (
        await fixture.database
          .select()
          .from(privacyProcessorPropagations)
          .where(eq(privacyProcessorPropagations.privacyRequestId, request.id))
      ).find((row) => row.processor === "search"),
    ).toMatchObject({
      state: "failed",
      resultCode: "search_reindex_required",
      evidenceReference: null,
    });
  });

  it("purges file-scoped evidence item and excerpt documents", async () => {
    const sourceId = newId();
    const evidenceItemId = newId();
    const excerptId = newId();
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: context.workspaceId,
      kind: "document",
      title: "File-only privacy source",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceItemId,
      workspaceId: context.workspaceId,
      sourceId,
      fileId: evidenceId,
      checksum: "file-only-evidence",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(evidenceExcerpts).values({
      id: excerptId,
      workspaceId: context.workspaceId,
      evidenceItemId,
      excerpt: "File-only excerpt",
      checksum: "file-only-excerpt",
      createdBy: context.actor.principalId,
    });
    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "evidence_item",
      resourceId: evidenceItemId,
      resultId: evidenceItemId,
    });
    await insertDocument({
      workspaceId: context.workspaceId,
      resourceKind: "evidence_excerpt",
      resourceId: excerptId,
      resultId: evidenceItemId,
    });

    const request = await fulfillRequest([], "deletion", [evidenceId]);
    await executePrivacyPropagations({
      adapters: {
        cache: createCachePrivacyProcessorAdapter(),
        search: createSearchPrivacyProcessorAdapter(),
      },
      database: fixture.database,
      now: new Date(Date.now() + 1_000),
    });

    expect(
      await fixture.database
        .select({ id: searchDocuments.id })
        .from(searchDocuments)
        .where(
          inArray(searchDocuments.resourceId, [evidenceItemId, excerptId]),
        ),
    ).toHaveLength(0);
    expect(
      (
        await fixture.database
          .select()
          .from(privacyProcessorPropagations)
          .where(eq(privacyProcessorPropagations.privacyRequestId, request.id))
      ).find((row) => row.processor === "search"),
    ).toMatchObject({ state: "succeeded" });
  });

  it("is idempotent and returns opaque stable evidence for an empty person scope", async () => {
    const request = {
      id: newId(),
      workspaceId: context.workspaceId,
      scope: { personIds: [], fileIds: [] },
    } as unknown as PrivacyRequestRow;
    const adapter = createSearchPrivacyProcessorAdapter();
    const first = await adapter({
      database: fixture.database,
      request,
      idempotencyKey: request.id,
    });
    const second = await adapter({
      database: fixture.database,
      request,
      idempotencyKey: request.id,
    });
    expect(first).toEqual({
      state: "not_applicable",
      evidenceReference: "search:no-scoped-people",
    });
    expect(second).toEqual(first);
  });
});
