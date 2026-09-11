import "server-only";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { newId } from "@/db/id";
import { aiReviewSuggestions, aiRuns, aiCitations } from "@/db/schema/ai";
import { personWebResearchRuns } from "@/db/schema/person-research";
import { evidenceItems, sources } from "@/db/schema/evidence";
import { people } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import {
  canAccessResource,
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { runResearchTransaction } from "@/modules/audit/transactions";
import {
  createCasesService,
  requireCaseResource,
} from "@/modules/cases/service";
import { checkPurposeCoverage } from "@/modules/governance/coverage";
import { createPeopleService } from "@/modules/people/service";
import { createFactsService } from "@/modules/facts/service";
import { createRelationshipsService } from "@/modules/relationships/service";
import { createEvidenceAssertionsService } from "@/modules/evidence/assertions";
import {
  normalizeAiSuggestion,
  normalizeAiReviewDecision,
  requireAiBatchApproval,
} from "./review-validation";
import type { AiSuggestionInput } from "./review-types";

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
      run.createdBy !== context.actor.principalId ||
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
      run.createdBy !== context.actor.principalId ||
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
    if (input.proposedValue.kind !== "profile") fail();
    const value = input.proposedValue.value;
    const original = (
      run.suggestions as Array<{
        field: string;
        value: string;
        sourceUrls: string[];
      }>
    ).find((s) => s.field === input.fieldKey && s.value === value);
    if (!original) fail();
    for (const reference of input.evidenceReferences)
      if (
        reference.kind !== "web" ||
        !original.sourceUrls.includes(reference.url) ||
        !snapshots.some(
          (source) =>
            source.url === reference.url &&
            (source.snippet || source.title) === reference.quote,
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
export type AiReviewSuggestion = Awaited<ReturnType<typeof project>>;

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
    if (!row || row.createdBy !== context.actor.principalId) fail();
    await authorizeAiReviewScope(scoped, proposal(row), write);
    await verifyProvenance(scoped, proposal(row));
    return row;
  }
  async function decide(scoped: ResearchServiceContext, raw: unknown) {
    if (scoped.actor.type !== "user")
      throw createGraphQLError("FORBIDDEN", "A human reviewer is required.");
    const input = normalizeAiReviewDecision(raw);
    const row = await get(scoped, input.id, true);
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
  const decision = (raw: unknown) =>
    runResearchTransaction(
      context,
      { requiredPermissions: [...readPermissions, "analysis:run"] },
      (scoped) => decide(scoped, raw),
    );
  return {
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
                eq(aiReviewSuggestions.createdBy, context.actor.principalId),
                inArray(aiReviewSuggestions.status, ["pending", "deferred"]),
              ),
            )
            .orderBy(desc(aiReviewSuggestions.createdAt))
            .limit(50);
          const result: AiReviewSuggestion[] = [];
          for (const row of rows) {
            try {
              await authorizeAiReviewScope(scoped, proposal(row));
              await verifyProvenance(scoped, proposal(row));
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
      id: string;
      expectedVersion: number;
      explicitConfirmed: boolean;
    }) => decision({ ...input, decision: "accepted" }),
    rejectSuggestion: (input: {
      id: string;
      expectedVersion: number;
      reason: string;
    }) => decision({ ...input, decision: "rejected" }),
    deferSuggestion: (input: {
      id: string;
      expectedVersion: number;
      reason?: string;
    }) => decision({ ...input, decision: "deferred" }),
    reviewBatch: async (input: {
      suggestions: Array<{ id: string; expectedVersion: number }>;
      approved: boolean;
    }) => {
      requireAiBatchApproval({
        ids: input.suggestions.map((s) => s.id),
        approved: input.approved,
      });
      return runResearchTransaction(
        context,
        { requiredPermissions: [...readPermissions, "analysis:run"] },
        async (scoped) => {
          const result = [];
          for (const item of [...input.suggestions].sort((a, b) =>
            a.id.localeCompare(b.id),
          ))
            result.push(
              await decide(scoped, {
                ...item,
                decision: "accepted",
                explicitConfirmed: true,
              }),
            );
          return result;
        },
      );
    },
  };
}
