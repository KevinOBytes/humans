import "server-only";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { newId } from "@/db/id";
import { aiReviewSuggestions, aiRuns, aiCitations } from "@/db/schema/ai";
import {
  personWebResearchRuns,
  personWebResearchSources,
} from "@/db/schema/person-research";
import {
  evidenceAssertions,
  evidenceExcerpts,
  evidenceItems,
  sourceCustodyEvents,
  sources,
} from "@/db/schema/evidence";
import { facts } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import { relationships } from "@/db/schema/relationships";
import { createGraphQLError } from "@/graphql/errors";
import {
  decodeResearchCursor,
  normalizePagination,
  type PaginationInput,
} from "@/graphql/limits";
import {
  canAccessResource,
  createAuditService,
  visibleResourceIds,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  runResearchTransaction,
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
} from "@/modules/audit/transactions";
import {
  createCasesService,
  requireCaseResource,
} from "@/modules/cases/service";
import { createCasesRepository } from "@/modules/cases/repository";
import { checkPurposeCoverage } from "@/modules/governance/coverage";
import { createPeopleService } from "@/modules/people/service";
import { createFactsService } from "@/modules/facts/service";
import { createRelationshipsService } from "@/modules/relationships/service";
import { createEvidenceAssertionsService } from "@/modules/evidence/assertions";
import { normalizeHumanText } from "@/modules/facts/validation";
import {
  acceptedAiEvidenceReferenceSchema,
  normalizeAiSuggestion,
  normalizeAiReviewDecision,
  requireAiBatchApproval,
} from "./review-validation";
import type { AiSuggestionInput } from "./review-types";
import {
  sourceSnapshotHash,
  sourceProviderAgreement,
} from "./source-provenance";
import type { SearchIndexMutation } from "@/modules/search/index-maintenance";

type Row = typeof aiReviewSuggestions.$inferSelect;
const readPermissions = ["analysis:read", "person:read"];
function fail(): never {
  throw createGraphQLError(
    "NOT_FOUND",
    "The requested AI suggestion was not found.",
  );
}
function permitted(context: ResearchServiceContext, permission: string) {
  if (!context.permissions.has(permission))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}

export async function authorizeAiReviewScope(
  context: ResearchServiceContext,
  input: {
    personId: string;
    purpose: string;
    caseId?: string | null;
    proposedValue?: AiSuggestionInput["proposedValue"];
  },
  write = false,
) {
  if (!input.purpose?.trim())
    throw createGraphQLError("FORBIDDEN", "A governed purpose is required.");
  if (input.caseId) {
    const caseRow = await createCasesService(context).getCase(input.caseId);
    if (caseRow.state !== "active" || caseRow.purpose !== input.purpose)
      throw createGraphQLError(
        "FORBIDDEN",
        "The case purpose is not permitted.",
      );
  }
  const personIds = [
    input.personId,
    ...(input.proposedValue?.kind === "relationship"
      ? [input.proposedValue.targetPersonId]
      : []),
  ];
  for (const personId of personIds) {
    await requireCaseResource(context, "person", personId);
    for (const scope of write
      ? (["ai_operation", "write"] as const)
      : (["ai_operation", "read"] as const)) {
      const coverage = await checkPurposeCoverage(context, {
        personId,
        purpose: input.purpose,
        caseReference: input.caseId,
        scope,
        fieldDefinitionId:
          input.proposedValue?.kind === "fact"
            ? input.proposedValue.definitionId
            : null,
      });
      if (!coverage.allowed)
        throw createGraphQLError(
          "FORBIDDEN",
          "Current purpose coverage is required.",
        );
    }
  }
}

async function verifyProvenance(
  context: ResearchServiceContext,
  input: AiSuggestionInput,
  options: { allowDifferentCreator?: boolean } = {},
) {
  if (input.runKind === "analysis") {
    const [run] = await context.database
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.workspaceId, context.workspaceId),
          eq(aiRuns.id, input.researchRunId),
        ),
      )
      .limit(1);
    if (
      !run ||
      run.state !== "completed" ||
      (!options.allowDifferentCreator &&
        run.createdBy !== context.actor.principalId) ||
      run.provider !== input.provider ||
      run.model !== input.model ||
      run.governancePurpose !== input.purpose ||
      run.governanceCaseReference !== (input.caseId ?? null) ||
      !run.reviewPersonIds.includes(input.personId)
    )
      fail();
    const citations = await context.database
      .select()
      .from(aiCitations)
      .where(
        and(
          eq(aiCitations.workspaceId, context.workspaceId),
          eq(aiCitations.aiRunId, run.id),
        ),
      );
    for (const reference of input.evidenceReferences)
      if (
        reference.kind !== "evidence" ||
        !citations.some(
          (citation) =>
            citation.evidenceItemId === reference.evidenceId &&
            citation.claimText.includes(reference.quote),
        )
      )
        fail();
  } else {
    const [run] = await context.database
      .select()
      .from(personWebResearchRuns)
      .where(
        and(
          eq(personWebResearchRuns.workspaceId, context.workspaceId),
          eq(personWebResearchRuns.id, input.researchRunId),
        ),
      )
      .limit(1);
    if (
      !run ||
      run.personId !== input.personId ||
      (!options.allowDifferentCreator &&
        run.createdBy !== context.actor.principalId) ||
      run.provider !== input.provider ||
      run.model !== input.model ||
      run.governancePurpose !== input.purpose ||
      run.governanceCaseReference !== (input.caseId ?? null)
    )
      fail();
    const snapshots = run.sources as Array<{
      url: string;
      snippet: string;
      title: string;
    }>;
    const persistedSnapshots = await context.database
      .select()
      .from(personWebResearchSources)
      .where(
        and(
          eq(personWebResearchSources.workspaceId, context.workspaceId),
          eq(personWebResearchSources.runId, run.id),
        ),
      );
    const sourcesForVerification = persistedSnapshots.length
      ? persistedSnapshots
      : snapshots.map((source) => ({
          ...source,
          retrievalHash: sourceSnapshotHash(source),
          provider: run.provider,
          model: run.model,
        }));
    if (
      sourcesForVerification.some(
        (source) =>
          source.provider !== run.provider ||
          source.model !== run.model ||
          source.retrievalHash !== sourceSnapshotHash(source),
      )
    )
      fail();
    if (
      input.proposedValue.kind !== "profile" &&
      input.proposedValue.kind !== "fact"
    )
      fail();
    let value: string;
    if (input.proposedValue.kind === "profile") {
      value = input.proposedValue.value;
    } else {
      if (!("text" in input.proposedValue.value)) fail();
      value = input.proposedValue.value.text;
    }
    const original = (
      run.suggestions as Array<{
        field: string;
        definitionId?: string;
        value: string;
        sourceUrls: string[];
      }>
    ).find(
      (s) =>
        s.field === input.fieldKey &&
        s.value === value &&
        (input.proposedValue.kind !== "fact" ||
          s.definitionId === input.proposedValue.definitionId),
    );
    if (!original) fail();
    for (const reference of input.evidenceReferences)
      if (
        reference.kind !== "web" ||
        !original.sourceUrls.includes(reference.url) ||
        !sourcesForVerification.some(
          (source) =>
            source.url === reference.url &&
            (source.snippet || source.title) === reference.quote &&
            (!("snapshotHash" in reference) ||
              !reference.snapshotHash ||
              source.retrievalHash === reference.snapshotHash),
        )
      )
        fail();
  }
  for (const reference of input.evidenceReferences) {
    if (reference.kind === "web") continue;
    permitted(context, "evidence:read");
    permitted(context, "source:read");
    const [row] = await context.database
      .select({ evidence: evidenceItems, source: sources })
      .from(evidenceItems)
      .innerJoin(
        sources,
        and(
          eq(sources.workspaceId, evidenceItems.workspaceId),
          eq(sources.id, evidenceItems.sourceId),
        ),
      )
      .where(
        and(
          eq(evidenceItems.workspaceId, context.workspaceId),
          eq(evidenceItems.id, reference.evidenceId),
          isNull(evidenceItems.deletedAt),
          isNull(sources.deletedAt),
        ),
      )
      .limit(1);
    if (
      !row ||
      !(await canAccessResource(context.database, context, {
        resourceKind: "evidence",
        id: row.evidence.id,
        sensitivity: row.evidence.sensitivity,
      })) ||
      !(await canAccessResource(context.database, context, {
        resourceKind: "source",
        id: row.source.id,
        sensitivity: row.source.sensitivity,
      }))
    )
      fail();
  }
}
function proposal(row: Row): AiSuggestionInput {
  return normalizeAiSuggestion({
    personId: row.personId,
    caseId: row.caseId,
    purpose: row.purpose,
    fieldKey: row.fieldKey,
    proposedValue: row.proposedValue,
    evidenceReferences: row.evidenceReferences,
    confidence: row.confidence,
    uncertainty: row.uncertainty,
    provider: row.provider,
    model: row.model,
    promptPolicyVersion: row.promptPolicyVersion,
    researchRunId: row.aiRunId ?? row.webRunId,
    runKind: row.aiRunId ? "analysis" : "web",
  });
}
async function project(context: ResearchServiceContext, row: Row) {
  const [person] = await context.database
    .select()
    .from(people)
    .where(
      and(
        eq(people.workspaceId, context.workspaceId),
        eq(people.id, row.personId),
      ),
    )
    .limit(1);
  const currentValue =
    row.proposedValue.kind === "profile" && person
      ? person[
          row.fieldKey as
            "displayName" | "preferredName" | "sortName" | "biography"
        ]
      : null;
  return {
    ...row,
    currentValue: currentValue ?? null,
    researchRunId: row.aiRunId ?? row.webRunId!,
  };
}

function webEvidenceFieldPath(
  resourceKind: string,
  fieldKey: string,
): string | null {
  return resourceKind === "person"
    ? fieldKey
    : resourceKind === "fact"
      ? "value"
      : null;
}

/**
 * Copies only the immutable snapshot a reviewer accepted into the ordinary
 * evidence graph. This is deliberately a database-level helper: review
 * acceptance already owns an outer transaction, so the source, custody,
 * evidence, excerpt, assertion, and review decision commit or roll back as a
 * single unit.
 */
async function promoteAcceptedWebEvidence(
  context: ResearchServiceContext,
  row: Row,
  acceptedResource: { id: string; kind: string },
): Promise<
  readonly {
    evidenceId: string;
    snapshotHash: string;
  }[]
> {
  const webReferences = row.evidenceReferences.filter(
    (
      reference,
    ): reference is Extract<
      AiSuggestionInput["evidenceReferences"][number],
      { kind: "web" }
    > => reference.kind === "web",
  );
  if (!webReferences.length) return [];

  const runId = row.webRunId;
  if (!runId) fail();
  const snapshotRows = await context.database
    .select()
    .from(personWebResearchSources)
    .where(
      and(
        eq(personWebResearchSources.workspaceId, context.workspaceId),
        eq(personWebResearchSources.runId, runId),
        eq(personWebResearchSources.personId, row.personId),
      ),
    );
  const snapshotsByUrl = new Map(
    snapshotRows.map((snapshot) => [snapshot.url, snapshot]),
  );
  const fieldPath = webEvidenceFieldPath(acceptedResource.kind, row.fieldKey);
  if (!fieldPath) fail();
  const promoted = [] as Array<{ evidenceId: string; snapshotHash: string }>;
  const searchMutations: SearchIndexMutation[] = [];

  for (const reference of webReferences) {
    const snapshot = snapshotsByUrl.get(reference.url);
    if (
      !snapshot ||
      !sourceProviderAgreement({
        runProvider: row.provider,
        runModel: row.model,
        sourceProvider: snapshot.provider,
        sourceModel: snapshot.model,
      }) ||
      snapshot.retrievalHash !==
        sourceSnapshotHash({
          url: snapshot.url,
          title: snapshot.title,
          snippet: snapshot.snippet,
          publicationDate: snapshot.publicationDate,
        }) ||
      (snapshot.snippet || snapshot.title) !== reference.quote ||
      (reference.snapshotHash != null &&
        reference.snapshotHash !== snapshot.retrievalHash)
    )
      fail();

    const sourceId = newId();
    const evidenceId = newId();
    const excerptId = newId();
    const assertionId = newId();
    const collectedAt = snapshot.collectionTimestamp;
    const metadata = {
      collectionTimestamp: collectedAt.toISOString(),
      model: snapshot.model,
      provider: snapshot.provider,
      purpose: row.purpose,
      retrievalHash: snapshot.retrievalHash,
      reviewerPrincipalId: context.actor.principalId,
      webResearchRunId: runId,
    };
    await context.database.insert(sources).values({
      id: sourceId,
      workspaceId: context.workspaceId,
      kind: "web",
      title: snapshot.title,
      canonicalUrl: snapshot.url,
      publicationDate: snapshot.publicationDate,
      collector: snapshot.provider,
      extractionMethod: "persisted_snapshot",
      collectionMethod: "ai_web_research",
      collectedAt,
      reliability: snapshot.reliability,
      sensitivity: "internal",
      metadata,
      contentHash: snapshot.retrievalHash,
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await context.database.insert(sourceCustodyEvents).values({
      id: newId(),
      workspaceId: context.workspaceId,
      sourceId,
      eventKind: "collected",
      occurredAt: collectedAt,
      collector: snapshot.provider,
      integrityHash: snapshot.retrievalHash,
      notes: "Accepted AI review promoted persisted web snapshot.",
      metadata,
      createdBy: context.actor.principalId,
    });
    await context.database.insert(evidenceItems).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      sourceId,
      externalLocator: snapshot.url,
      extractedText: reference.quote,
      capturedAt: collectedAt,
      checksum: `sha256:${snapshot.retrievalHash}`,
      reviewState: "accepted",
      sensitivity: "internal",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await context.database.insert(evidenceExcerpts).values({
      id: excerptId,
      workspaceId: context.workspaceId,
      evidenceItemId: evidenceId,
      locator: reference.locator,
      excerpt: reference.quote,
      checksum: `sha256:${snapshot.retrievalHash}`,
      redactionState: "clear",
      createdBy: context.actor.principalId,
    });
    await context.database.insert(evidenceAssertions).values({
      id: assertionId,
      workspaceId: context.workspaceId,
      evidenceId,
      resourceKind: acceptedResource.kind,
      resourceId: acceptedResource.id,
      fieldPath,
      caseId: row.caseId,
      purpose: row.purpose,
      locator: reference.locator,
      quote: reference.quote,
      role: "supports",
      confidence: row.confidence.toFixed(3),
      reviewState: "approved",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    searchMutations.push(
      {
        action: "upsert",
        sourceId,
        sourceKind: "source",
        sourceVersion: 1,
        workspaceId: context.workspaceId,
      },
      {
        action: "upsert",
        sourceId: evidenceId,
        sourceKind: "evidence_item",
        sourceVersion: 1,
        workspaceId: context.workspaceId,
      },
      {
        action: "upsert",
        sourceId: excerptId,
        sourceKind: "evidence_excerpt",
        sourceVersion: 1,
        workspaceId: context.workspaceId,
      },
    );
    promoted.push({
      evidenceId,
      snapshotHash: snapshot.retrievalHash,
    });
    await createAuditService(context).write(context.database, {
      action: "ai.suggestion.web_evidence.promoted",
      resourceKind: "evidence_assertion",
      resourceId: assertionId,
      changedFields: ["source", "evidence", "excerpt", "fieldPath"],
      metadata: {
        evidenceId,
        sourceId,
        webResearchRunId: runId,
      },
    });
  }
  await applySearchIndexMaintenance(context, context.database, searchMutations);
  return promoted;
}
export type AiReviewSuggestion = Awaited<ReturnType<typeof project>>;

export type AcceptedAiEvidenceReference = {
  kind: "evidence" | "web";
  evidenceId: string | null;
  url: string | null;
  locator: string | null;
  quote: string | null;
  snapshotHash: string | null;
  redacted: boolean;
};

export type AcceptedAiHistoryItem = {
  id: string;
  personId: string;
  caseId: string | null;
  purpose: string;
  fieldKey: string;
  confidence: number;
  uncertainty: string;
  provider: string;
  model: string;
  promptPolicyVersion: string;
  researchRunId: string;
  reviewerPrincipalId: string;
  suggestedAt: Date;
  reviewedAt: Date;
  decisionReason: string | null;
  acceptedResource: {
    kind: "person" | "fact" | "relationship";
    id: string | null;
    redacted: boolean;
  };
  evidenceReferences: AcceptedAiEvidenceReference[];
};

export type AcceptedAiHistoryConnection = {
  nodes: AcceptedAiHistoryItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type AcceptedHistoryCursor = { reviewedAt: Date; id: string };

function acceptedHistoryCursor(row: Pick<Row, "id" | "reviewedAt">): string {
  if (!row.reviewedAt)
    throw createGraphQLError(
      "INTERNAL",
      "The accepted research history is unavailable.",
    );
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: "ai-review-accepted-desc",
      t: row.reviewedAt.toISOString(),
      i: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function acceptedHistoryAfter(
  value: string | null,
): AcceptedHistoryCursor | null {
  const decoded = decodeResearchCursor(value, "ai-review-accepted-desc");
  return decoded
    ? { reviewedAt: new Date(decoded.t as string), id: decoded.i as string }
    : null;
}

function acceptedHistoryPurpose(value: string): string {
  const normalized = normalizeHumanText(value, {
    path: ["purpose"],
    min: 1,
    max: 200,
  });
  if (normalized.issues.length)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The governed purpose is invalid.",
    );
  return normalized.value!.toLowerCase();
}

async function acceptedHistoryVisibleResources(
  context: ResearchServiceContext,
  rows: readonly Row[],
): Promise<ReadonlySet<string>> {
  const visible = new Set<string>();
  const configurations = [
    { kind: "person" as const, permission: "person:read", table: people },
    { kind: "fact" as const, permission: "fact:read", table: facts },
    {
      kind: "relationship" as const,
      permission: "relationship:read",
      table: relationships,
    },
  ];
  for (const configuration of configurations) {
    if (!context.permissions.has(configuration.permission)) continue;
    const ids = [
      ...new Set(
        rows
          .filter((row) => row.acceptedResourceKind === configuration.kind)
          .flatMap((row) =>
            row.acceptedResourceId ? [row.acceptedResourceId] : [],
          ),
      ),
    ];
    if (!ids.length) continue;
    const resources = await context.database
      .select({
        id: configuration.table.id,
        sensitivity: configuration.table.sensitivity,
      })
      .from(configuration.table)
      .where(
        and(
          eq(configuration.table.workspaceId, context.workspaceId),
          inArray(configuration.table.id, ids),
          isNull(configuration.table.deletedAt),
        ),
      );
    const idsForKind = await visibleResourceIds(context.database, context, {
      resourceKind: configuration.kind,
      resources,
    });
    for (const id of idsForKind) visible.add(id);
  }
  return visible;
}

async function acceptedHistoryVisibleEvidence(
  context: ResearchServiceContext,
  rows: readonly Row[],
): Promise<ReadonlySet<string>> {
  if (
    !context.permissions.has("evidence:read") ||
    !context.permissions.has("source:read")
  )
    return new Set();
  const parsedReferences = rows.flatMap((row) => {
    const parsed = acceptedAiEvidenceReferenceSchema
      .array()
      .safeParse(row.acceptedEvidenceReferences);
    return parsed.success
      ? parsed.data.flatMap((reference) =>
          reference.kind === "evidence"
            ? [reference.evidenceId]
            : reference.promotedEvidenceId
              ? [reference.promotedEvidenceId]
              : [],
        )
      : [];
  });
  const evidenceIds = [...new Set(parsedReferences)];
  if (!evidenceIds.length) return new Set();
  const evidenceRows = await context.database
    .select({
      id: evidenceItems.id,
      sensitivity: evidenceItems.sensitivity,
      sourceId: evidenceItems.sourceId,
    })
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, context.workspaceId),
        inArray(evidenceItems.id, evidenceIds),
        isNull(evidenceItems.deletedAt),
      ),
    );
  const sourceIds = [...new Set(evidenceRows.map((row) => row.sourceId))];
  if (!sourceIds.length) return new Set();
  const sourceRows = await context.database
    .select({ id: sources.id, sensitivity: sources.sensitivity })
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, context.workspaceId),
        inArray(sources.id, sourceIds),
        isNull(sources.deletedAt),
      ),
    );
  const [visibleEvidence, visibleSources] = await Promise.all([
    visibleResourceIds(context.database, context, {
      resourceKind: "evidence",
      resources: evidenceRows,
    }),
    visibleResourceIds(context.database, context, {
      resourceKind: "source",
      resources: sourceRows,
    }),
  ]);
  return new Set(
    evidenceRows
      .filter(
        (row) =>
          visibleEvidence.has(row.id) && visibleSources.has(row.sourceId),
      )
      .map((row) => row.id),
  );
}

async function projectAcceptedHistory(
  context: ResearchServiceContext,
  rows: readonly Row[],
): Promise<AcceptedAiHistoryItem[]> {
  const [visibleResources, visibleEvidence] = await Promise.all([
    acceptedHistoryVisibleResources(context, rows),
    acceptedHistoryVisibleEvidence(context, rows),
  ]);
  return rows.map((row) => {
    const references = acceptedAiEvidenceReferenceSchema
      .array()
      .safeParse(row.acceptedEvidenceReferences);
    if (
      !references.success ||
      !row.acceptedFromRunId ||
      !row.reviewedBy ||
      !row.reviewedAt ||
      !row.acceptedResourceId ||
      !["person", "fact", "relationship"].includes(
        row.acceptedResourceKind ?? "",
      )
    )
      throw createGraphQLError(
        "INTERNAL",
        "The accepted research history is unavailable.",
      );
    const resourceVisible = visibleResources.has(row.acceptedResourceId);
    return {
      id: row.id,
      personId: row.personId,
      caseId: row.caseId,
      purpose: row.purpose,
      fieldKey: row.fieldKey,
      confidence: row.confidence,
      uncertainty: row.uncertainty,
      provider: row.provider,
      model: row.model,
      promptPolicyVersion: row.promptPolicyVersion,
      researchRunId: row.acceptedFromRunId,
      reviewerPrincipalId: row.reviewedBy,
      suggestedAt: row.createdAt,
      reviewedAt: row.reviewedAt,
      decisionReason: row.decisionReason,
      acceptedResource: {
        kind: row.acceptedResourceKind as "person" | "fact" | "relationship",
        id: resourceVisible ? row.acceptedResourceId : null,
        redacted: !resourceVisible,
      },
      evidenceReferences: references.data.map((reference) => {
        if (reference.kind === "web") {
          const evidenceVisible =
            reference.promotedEvidenceId != null &&
            visibleEvidence.has(reference.promotedEvidenceId);
          return {
            kind: "web" as const,
            evidenceId: evidenceVisible ? reference.promotedEvidenceId! : null,
            url: evidenceVisible ? reference.url : null,
            locator: evidenceVisible ? reference.locator : null,
            quote: evidenceVisible ? reference.quote : null,
            snapshotHash: evidenceVisible
              ? (reference.snapshotHash ?? null)
              : null,
            redacted: !evidenceVisible,
          };
        }
        const evidenceVisible = visibleEvidence.has(reference.evidenceId);
        return {
          kind: "evidence" as const,
          evidenceId: evidenceVisible ? reference.evidenceId : null,
          url: null,
          locator: evidenceVisible ? reference.locator : null,
          quote: evidenceVisible ? reference.quote : null,
          snapshotHash: null,
          redacted: !evidenceVisible,
        };
      }),
    };
  });
}

/**
 * A suggestion author may inspect their own pending work, but may not make a
 * review decision on it. Cross-user review is limited to workspace owners and
 * administrators, or to an explicitly assigned case owner/reviewer. The
 * latter keeps case-linked suggestions inside the case's sharing boundary.
 */
async function isIndependentReviewer(
  context: ResearchServiceContext,
  row: Row,
) {
  if (
    context.actor.type !== "user" ||
    row.createdBy === context.actor.principalId
  )
    return false;

  if (row.caseId) {
    const membership = await createCasesRepository(context.database).get(
      context.workspaceId,
      row.caseId,
      context.actor.principalId,
    );
    return (
      membership?.case.state === "active" &&
      ["owner", "reviewer"].includes(membership.role)
    );
  }

  return (
    context.permissions.has("workspace:update") &&
    (context.actor.role === "owner" || context.actor.role === "admin")
  );
}

async function requireIndependentReviewer(
  context: ResearchServiceContext,
  row: Row,
) {
  if (!(await isIndependentReviewer(context, row)))
    throw createGraphQLError(
      "FORBIDDEN",
      "An independent workspace or case reviewer is required.",
    );
}

/** Internal producer entry point: never exposed as arbitrary client-supplied provenance. */
export async function recordAiSuggestion(
  context: ResearchServiceContext,
  raw: AiSuggestionInput,
) {
  const input = normalizeAiSuggestion(raw);
  await authorizeAiReviewScope(context, input);
  await verifyProvenance(context, input);
  const { researchRunId, runKind, ...columns } = input;
  const [row] = await context.database
    .insert(aiReviewSuggestions)
    .values({
      ...columns,
      id: newId(),
      workspaceId: context.workspaceId,
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
      aiRunId: runKind === "analysis" ? researchRunId : null,
      webRunId: runKind === "web" ? researchRunId : null,
    })
    .returning();
  if (!row) fail();
  await createAuditService(context).write(context.database, {
    action: "ai.suggestion.created",
    resourceKind: "ai_suggestion",
    resourceId: row.id,
    changedFields: ["proposal", "provenance"],
  });
  return project(context, row);
}

export function createAiReviewService(context: ResearchServiceContext) {
  async function get(
    scoped: ResearchServiceContext,
    id: string,
    write = false,
  ) {
    const [row] = await scoped.database
      .select()
      .from(aiReviewSuggestions)
      .where(
        and(
          eq(aiReviewSuggestions.workspaceId, scoped.workspaceId),
          eq(aiReviewSuggestions.id, id),
        ),
      )
      .for(write ? "update" : "share")
      .limit(1);
    if (!row) fail();
    const independentReviewer = await isIndependentReviewer(scoped, row);
    if (row.createdBy !== scoped.actor.principalId && !independentReviewer)
      fail();
    await authorizeAiReviewScope(scoped, proposal(row), write);
    await verifyProvenance(scoped, proposal(row), {
      allowDifferentCreator: independentReviewer,
    });
    return row;
  }
  async function decide(
    scoped: ResearchServiceContext,
    raw: unknown,
    keyed = false,
  ) {
    if (scoped.actor.type !== "user")
      throw createGraphQLError("FORBIDDEN", "A human reviewer is required.");
    const input = normalizeAiReviewDecision(raw);
    const row = await get(scoped, input.id, true);
    await requireIndependentReviewer(scoped, row);
    if (
      !keyed &&
      row.status === "accepted" &&
      input.decision === "accepted" &&
      row.version === input.expectedVersion + 1
    )
      return project(scoped, row);
    if (
      row.version !== input.expectedVersion ||
      !["pending", "deferred"].includes(row.status)
    )
      throw createGraphQLError(
        "CONFLICT",
        "The suggestion has already changed.",
      );
    let acceptedResourceId: string | null = null;
    let acceptedResourceKind: string | null = null;
    let acceptedEvidenceReferences: unknown = null;
    if (input.decision === "accepted") {
      const value = row.proposedValue;
      const governance = {
        governancePurpose: row.purpose,
        governanceCaseReference: row.caseId,
      };
      if (value.kind === "profile") {
        permitted(scoped, "person:update");
        const current = await createPeopleService(scoped).get(row.personId);
        if (!current) fail();
        const outcome = await createPeopleService(scoped).update({
          id: row.personId,
          expectedVersion: current.version,
          [row.fieldKey]: value.value,
        });
        if (!outcome.resource)
          throw createGraphQLError(
            outcome.code === "VALIDATION_FAILED"
              ? "VALIDATION_FAILED"
              : "CONFLICT",
            "The proposed field could not be applied.",
          );
        acceptedResourceId = outcome.resource.id;
        acceptedResourceKind = "person";
      } else if (value.kind === "fact") {
        permitted(scoped, "fact:create");
        const outcome = await createFactsService(scoped).create({
          personId: row.personId,
          definitionId: value.definitionId,
          value: value.value,
          confidence: row.confidence,
          confidenceMethod: "human_reviewed_ai",
          confidenceExplanation: row.uncertainty,
          reviewState: "unreviewed",
          ...governance,
        });
        if (!outcome.resource)
          throw createGraphQLError(
            outcome.code === "VALIDATION_FAILED"
              ? "VALIDATION_FAILED"
              : "CONFLICT",
            "The proposed fact could not be applied.",
          );
        acceptedResourceId = outcome.resource.id;
        acceptedResourceKind = "fact";
      } else {
        permitted(scoped, "relationship:create");
        const outcome = await createRelationshipsService(scoped).create({
          sourcePersonId: row.personId,
          targetPersonId: value.targetPersonId,
          relationshipTypeId: value.relationshipTypeId,
          confidence: row.confidence,
          state: "inferred",
          creationMethod: "ai",
          explicitConfirmed: true,
          caseId: row.caseId,
          ...governance,
        });
        if (!outcome.resource)
          throw createGraphQLError(
            outcome.code === "VALIDATION_FAILED"
              ? "VALIDATION_FAILED"
              : "CONFLICT",
            "The proposed relationship could not be applied.",
          );
        acceptedResourceId = outcome.resource.id;
        acceptedResourceKind = "relationship";
      }
      for (const reference of row.evidenceReferences) {
        if (reference.kind !== "evidence") continue;
        await createEvidenceAssertionsService(scoped).link({
          evidenceId: reference.evidenceId,
          locator: reference.locator,
          quote: reference.quote,
          role: "supports",
          confidence: row.confidence,
          resourceId: acceptedResourceId!,
          resourceKind: acceptedResourceKind!,
          purpose: row.purpose,
          caseId: row.caseId,
          explicitConfirmed: true,
        });
      }
      const promotedWebEvidence = await promoteAcceptedWebEvidence(
        scoped,
        row,
        {
          id: acceptedResourceId!,
          kind: acceptedResourceKind!,
        },
      );
      let webReferenceIndex = 0;
      acceptedEvidenceReferences = row.evidenceReferences.map((reference) => {
        if (reference.kind !== "web") return reference;
        const promoted = promotedWebEvidence[webReferenceIndex++];
        if (!promoted) fail();
        return {
          ...reference,
          promotedEvidenceId: promoted.evidenceId,
          snapshotHash: promoted.snapshotHash,
        };
      });
      if (webReferenceIndex !== promotedWebEvidence.length) fail();
    }
    const [updated] = await scoped.database
      .update(aiReviewSuggestions)
      .set({
        status: input.decision,
        version: row.version + 1,
        updatedBy: scoped.actor.principalId,
        updatedAt: new Date(),
        reviewedBy: scoped.actor.principalId,
        reviewedAt: new Date(),
        decisionReason: input.reason ?? null,
        acceptedResourceId,
        acceptedResourceKind,
        acceptedFromRunId:
          input.decision === "accepted" ? (row.aiRunId ?? row.webRunId) : null,
        acceptedEvidenceReferences:
          input.decision === "accepted" ? acceptedEvidenceReferences : null,
      })
      .where(
        and(
          eq(aiReviewSuggestions.workspaceId, scoped.workspaceId),
          eq(aiReviewSuggestions.id, row.id),
          eq(aiReviewSuggestions.version, row.version),
        ),
      )
      .returning();
    if (!updated) fail();
    await createAuditService(scoped).write(scoped.database, {
      action: `ai.suggestion.${input.decision}`,
      resourceKind: "ai_suggestion",
      resourceId: row.id,
      changedFields: ["status", "reviewedBy", "acceptedResourceId"],
    });
    return project(scoped, updated);
  }
  async function decisions(
    items: ReturnType<typeof normalizeAiReviewDecision>[],
    idempotencyKey: string | null | undefined,
    batch = false,
  ) {
    if (context.actor.type !== "user")
      throw createGraphQLError("FORBIDDEN", "A human reviewer is required.");
    const permissions = [...readPermissions, "analysis:run"];
    // Stable lock order prevents opposite-order batches from deadlocking. The
    // caller's complete ordered material remains bound to its one ledger claim.
    const apply = async (scoped: ResearchServiceContext) => {
      const result = [];
      for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id)))
        result.push(await decide(scoped, item, idempotencyKey != null));
      return result;
    };
    if (idempotencyKey == null)
      return runResearchTransaction(
        context,
        { requiredPermissions: permissions },
        apply,
      );
    if (!context.idempotencyHmacKey)
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "Retry protection is unavailable.",
      );
    const claim = derivePrincipalResearchIdempotency(context, {
      idempotencyKey,
      operation: batch ? "ai.review.batch" : "ai.review.decision",
      secret: context.idempotencyHmacKey,
      expiresAt: new Date(Date.now() + 86_400_000),
      requestMaterial: {
        suggestions: items.map((item) => ({
          id: item.id,
          expectedVersion: item.expectedVersion,
          decision: item.decision,
          reason: item.reason ?? null,
          explicitConfirmed: item.explicitConfirmed ?? false,
        })),
      },
    });
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      claim,
      permissions,
      async (scoped) => {
        const result = await apply(scoped);
        // Only opaque identifiers and committed state enter the shared ledger.
        return {
          suggestions: JSON.stringify(
            result.map((row) => ({
              id: row.id,
              version: row.version,
              status: row.status,
            })),
          ),
        };
      },
    );
    const opaque = z
      .object({ suggestions: z.string().max(8000) })
      .strict()
      .safeParse(executed.responseReference);
    let decoded: unknown;
    try {
      decoded = opaque.success ? JSON.parse(opaque.data.suggestions) : null;
    } catch {
      decoded = null;
    }
    const references = z
      .array(
        z
          .object({
            id: z.uuid(),
            version: z.number().int().positive(),
            status: z.enum(["accepted", "rejected", "deferred"]),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .safeParse(decoded);
    const expected = [...items].sort((a, b) => a.id.localeCompare(b.id));
    if (
      !references.success ||
      references.data.length !== expected.length ||
      references.data.some(
        (ref, i) =>
          ref.id !== expected[i]!.id ||
          ref.version !== expected[i]!.expectedVersion + 1 ||
          ref.status !== expected[i]!.decision,
      )
    )
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The review retry reference is invalid.",
      );
    // Fresh transaction reauthorizes completed claims; a ledger hit is never
    // permission to disclose stale person, case, provenance, or evidence data.
    return runResearchTransaction(
      context,
      { requiredPermissions: permissions },
      async (scoped) => {
        if (scoped.actor.type !== "user")
          throw createGraphQLError(
            "FORBIDDEN",
            "A human reviewer is required.",
          );
        const result = [];
        for (const ref of references.data) {
          const row = await get(scoped, ref.id, true);
          await requireIndependentReviewer(scoped, row);
          if (
            row.version !== ref.version ||
            row.status !== ref.status ||
            row.reviewedBy !== scoped.actor.principalId
          )
            throw createGraphQLError(
              "CONFLICT",
              "The suggestion has already changed.",
            );
          if (row.status === "accepted") {
            const resource = await acceptedHistoryVisibleResources(scoped, [
              row,
            ]);
            const evidence = await acceptedHistoryVisibleEvidence(scoped, [
              row,
            ]);
            const refs = acceptedAiEvidenceReferenceSchema
              .array()
              .safeParse(row.acceptedEvidenceReferences);
            if (
              !row.acceptedResourceId ||
              !resource.has(row.acceptedResourceId) ||
              !refs.success ||
              refs.data.some(
                (r) =>
                  !evidence.has(
                    r.kind === "evidence"
                      ? r.evidenceId
                      : (r.promotedEvidenceId ?? ""),
                  ),
              )
            )
              fail();
          }
          result.push(await project(scoped, row));
        }
        return result;
      },
    );
  }
  const decision = async (raw: unknown) => {
    const input = normalizeAiReviewDecision(raw);
    return (await decisions([input], input.idempotencyKey))[0]!;
  };
  return {
    async listAcceptedHistory(
      input: {
        personId: string;
        caseId?: string | null;
        purpose: string;
      } & PaginationInput,
    ): Promise<AcceptedAiHistoryConnection> {
      return runResearchTransaction(
        context,
        { requiredPermissions: readPermissions },
        async (scoped) => {
          const purpose = acceptedHistoryPurpose(input.purpose);
          const caseId = input.caseId ?? null;
          await authorizeAiReviewScope(scoped, {
            personId: input.personId,
            purpose,
            caseId,
          });
          const page = normalizePagination(input);
          const after = acceptedHistoryAfter(page.after);
          const rows = await scoped.database
            .select()
            .from(aiReviewSuggestions)
            .where(
              and(
                eq(aiReviewSuggestions.workspaceId, scoped.workspaceId),
                eq(aiReviewSuggestions.personId, input.personId),
                eq(aiReviewSuggestions.purpose, purpose),
                caseId
                  ? eq(aiReviewSuggestions.caseId, caseId)
                  : isNull(aiReviewSuggestions.caseId),
                eq(aiReviewSuggestions.status, "accepted"),
                isNotNull(aiReviewSuggestions.reviewedAt),
                after
                  ? or(
                      lt(aiReviewSuggestions.reviewedAt, after.reviewedAt),
                      and(
                        eq(aiReviewSuggestions.reviewedAt, after.reviewedAt),
                        lt(aiReviewSuggestions.id, after.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(
              desc(aiReviewSuggestions.reviewedAt),
              desc(aiReviewSuggestions.id),
            )
            .limit(page.first + 1);
          const pageRows = rows.slice(0, page.first);
          return {
            nodes: await projectAcceptedHistory(scoped, pageRows),
            pageInfo: {
              hasNextPage: rows.length > page.first,
              endCursor: pageRows.at(-1)
                ? acceptedHistoryCursor(pageRows.at(-1)!)
                : null,
            },
          };
        },
      );
    },
    async listSuggestions(input: {
      personId: string;
      caseId?: string | null;
      purpose: string;
    }) {
      return runResearchTransaction(
        context,
        { requiredPermissions: readPermissions },
        async (scoped) => {
          await authorizeAiReviewScope(scoped, input);
          const rows = await scoped.database
            .select()
            .from(aiReviewSuggestions)
            .where(
              and(
                eq(aiReviewSuggestions.workspaceId, context.workspaceId),
                eq(aiReviewSuggestions.personId, input.personId),
                eq(aiReviewSuggestions.purpose, input.purpose),
                input.caseId
                  ? eq(aiReviewSuggestions.caseId, input.caseId)
                  : isNull(aiReviewSuggestions.caseId),
                inArray(aiReviewSuggestions.status, ["pending", "deferred"]),
              ),
            )
            .orderBy(desc(aiReviewSuggestions.createdAt))
            .limit(50);
          const result: AiReviewSuggestion[] = [];
          for (const row of rows) {
            try {
              const independentReviewer = await isIndependentReviewer(
                scoped,
                row,
              );
              if (
                row.createdBy !== scoped.actor.principalId &&
                !independentReviewer
              )
                continue;
              await authorizeAiReviewScope(scoped, proposal(row));
              await verifyProvenance(scoped, proposal(row), {
                allowDifferentCreator: independentReviewer,
              });
              result.push(await project(scoped, row));
            } catch (error) {
              if (
                error instanceof Error &&
                "extensions" in error &&
                ["FORBIDDEN", "NOT_FOUND"].includes(
                  String((error.extensions as { code?: string }).code),
                )
              )
                continue;
              throw error;
            }
          }
          return result;
        },
      );
    },
    getSuggestion: (id: string) =>
      runResearchTransaction(
        context,
        { requiredPermissions: readPermissions },
        async (scoped) => project(scoped, await get(scoped, id)),
      ),
    acceptSuggestion: (input: {
      idempotencyKey?: string | null;
      id: string;
      expectedVersion: number;
      explicitConfirmed: boolean;
    }) => decision({ ...input, decision: "accepted" }),
    rejectSuggestion: (input: {
      idempotencyKey?: string | null;
      id: string;
      expectedVersion: number;
      reason: string;
    }) => decision({ ...input, decision: "rejected" }),
    deferSuggestion: (input: {
      idempotencyKey?: string | null;
      id: string;
      expectedVersion: number;
      reason?: string;
    }) => decision({ ...input, decision: "deferred" }),
    reviewBatch: async (input: {
      idempotencyKey?: string | null;
      suggestions: Array<{ id: string; expectedVersion: number }>;
      approved: boolean;
    }) => {
      requireAiBatchApproval({
        ids: input.suggestions.map((s) => s.id),
        approved: input.approved,
      });
      const items = input.suggestions.map((item) =>
        normalizeAiReviewDecision({
          ...item,
          decision: "accepted",
          explicitConfirmed: true,
        }),
      );
      requireAiBatchApproval({
        ids: items.map((item) => item.id),
        approved: input.approved,
      });
      return decisions(items, input.idempotencyKey, true);
    },
  };
}
