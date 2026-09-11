import { and, eq, isNull, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import {
  evidenceAssertions,
  evidenceAssertionReviews,
  evidenceItems,
  sources,
} from "@/db/schema/evidence";
import { relationships } from "@/db/schema/relationships";
import { createGraphQLError } from "@/graphql/errors";
import {
  canAccessResource,
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { withResearchWriteTransaction } from "@/modules/audit/transactions";
import {
  createCasesService,
  requireCaseResource,
  requireResourceCoverage,
} from "@/modules/cases/service";
import type { CaseResourceKind } from "@/modules/cases/types";
import { boundedCaseText } from "@/modules/cases/validation";
import { normalizeGovernanceContext } from "@/modules/governance/validation";
import {
  normalizeEvidenceAssertion,
  requireReviewedPromotion,
  requiresRelationshipPromotionReview,
} from "./assertions-validation";

type AssertionInput = {
  evidenceId: string;
  resourceKind: string;
  resourceId: string;
  locator: string;
  quote: string;
  role: string;
  confidence: number;
  purpose: string;
  caseId?: string | null;
  explicitConfirmed: boolean;
};
export function createEvidenceAssertionsService(
  context: ResearchServiceContext,
) {
  return {
    link: (input: AssertionInput) => linkEvidenceAssertion(context, input),
    review: (input: Parameters<typeof reviewEvidenceAssertion>[1]) =>
      reviewEvidenceAssertion(context, input),
  };
}
export type EvidenceAssertionsService = ReturnType<
  typeof createEvidenceAssertionsService
>;
function permitted(context: ResearchServiceContext, permission: string) {
  if (!context.permissions.has(permission))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}
async function requireEvidence(context: ResearchServiceContext, id: string) {
  permitted(context, "evidence:read");
  permitted(context, "source:read");
  const [row] = await context.database
    .select({
      evidenceId: evidenceItems.id,
      evidenceSensitivity: evidenceItems.sensitivity,
      sourceId: sources.id,
      sourceSensitivity: sources.sensitivity,
      sourceReliability: sources.reliability,
    })
    .from(evidenceItems)
    .innerJoin(
      sources,
      and(
        eq(evidenceItems.workspaceId, sources.workspaceId),
        eq(evidenceItems.sourceId, sources.id),
      ),
    )
    .where(
      and(
        eq(evidenceItems.workspaceId, context.workspaceId),
        eq(evidenceItems.id, id),
        isNull(evidenceItems.deletedAt),
        isNull(sources.deletedAt),
      ),
    )
    .limit(1);
  if (
    !row ||
    !(await canAccessResource(context.database, context, {
      resourceKind: "evidence",
      id,
      sensitivity: row.evidenceSensitivity,
    })) ||
    !(await canAccessResource(context.database, context, {
      resourceKind: "source",
      id: row.sourceId,
      sensitivity: row.sourceSensitivity,
    }))
  )
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  return row;
}
async function requireAssertion(context: ResearchServiceContext, id: string) {
  const [row] = await context.database
    .select()
    .from(evidenceAssertions)
    .where(
      and(
        eq(evidenceAssertions.workspaceId, context.workspaceId),
        eq(evidenceAssertions.id, id),
        isNull(evidenceAssertions.deletedAt),
      ),
    )
    .limit(1);
  if (!row)
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  if (row.caseId) await createCasesService(context).getCase(row.caseId);
  const resource = await requireCaseResource(
    context,
    row.resourceKind as CaseResourceKind,
    row.resourceId,
  );
  await requireResourceCoverage(
    context,
    resource,
    row.purpose,
    row.caseId,
    "write",
  );
  const evidence = await requireEvidence(context, row.evidenceId);
  return { row, evidence };
}
export async function linkEvidenceAssertion(
  context: ResearchServiceContext,
  input: AssertionInput,
) {
  permitted(context, "evidence:update");
  permitted(context, `${input.resourceKind}:update`);
  if (!input.explicitConfirmed)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Explicit confirmation is required.",
    );
  const normalized = normalizeEvidenceAssertion(input);
  const governance = normalizeGovernanceContext({
    governancePurpose: input.purpose,
    governanceCaseReference: input.caseId,
  });
  return withResearchWriteTransaction(context, async (database) => {
    const scoped = { ...context, database };
    if (input.caseId) {
      const caseRow = await createCasesService(scoped).getCase(input.caseId);
      if (
        caseRow.purpose !== governance.governancePurpose ||
        caseRow.state !== "active"
      )
        throw createGraphQLError(
          "FORBIDDEN",
          "The case purpose is not permitted.",
        );
    }
    const resource = await requireCaseResource(
      scoped,
      normalized.resourceKind,
      input.resourceId,
    );
    await requireResourceCoverage(
      scoped,
      resource,
      governance.governancePurpose!,
      input.caseId ?? null,
      "write",
    );
    const evidence = await requireEvidence(scoped, input.evidenceId);
    const [row] = await database
      .insert(evidenceAssertions)
      .values({
        id: newId(),
        workspaceId: context.workspaceId,
        ...normalized,
        evidenceId: input.evidenceId,
        resourceId: input.resourceId,
        caseId: input.caseId,
        purpose: governance.governancePurpose!,
        createdBy: context.actor.principalId,
        updatedBy: context.actor.principalId,
      })
      .returning();
    if (!row) throw new Error("Assertion insert failed");
    const auditReference = await createAuditService(context).write(database, {
      action: "evidence.assertion.link",
      resourceKind: "evidence_assertion",
      resourceId: row.id,
      changedFields: ["locator", "quote", "role", "confidence"],
      sensitivity: resource.sensitivity,
    });
    return {
      ...row,
      auditReference,
      sourceReliability: evidence.sourceReliability,
      informationCredibility: row.confidence,
    };
  });
}
export async function reviewEvidenceAssertion(
  context: ResearchServiceContext,
  input: { id: string; expectedVersion: number; state: string; reason: string },
) {
  permitted(context, "workspace:update");
  permitted(context, "evidence:update");
  if (!["approved", "rejected"].includes(input.state))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The review state is invalid.",
    );
  const reason = boundedCaseText(input.reason, 2000);
  return withResearchWriteTransaction(context, async (database) => {
    const scoped = { ...context, database };
    const { row, evidence } = await requireAssertion(scoped, input.id);
    // An independent human reviewer, not an API key or the assertion author.
    if (
      context.actor.type !== "user" ||
      row.createdBy === context.actor.principalId
    )
      throw createGraphQLError(
        "FORBIDDEN",
        "An independent reviewer is required.",
      );
    if (row.resourceKind !== "relationship")
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "Only relationship assertion reviews are currently supported.",
      );
    const [relationship] = await database
      .select({ version: relationships.version })
      .from(relationships)
      .where(
        and(
          eq(relationships.workspaceId, context.workspaceId),
          eq(relationships.id, row.resourceId),
          isNull(relationships.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!relationship)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    const [updated] = await database
      .update(evidenceAssertions)
      .set({
        reviewState: input.state,
        version: sql`${evidenceAssertions.version} + 1`,
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      })
      .where(
        and(
          eq(evidenceAssertions.workspaceId, context.workspaceId),
          eq(evidenceAssertions.id, row.id),
          eq(evidenceAssertions.version, input.expectedVersion),
          eq(evidenceAssertions.reviewState, "unreviewed"),
          isNull(evidenceAssertions.deletedAt),
        ),
      )
      .returning();
    if (!updated)
      throw createGraphQLError(
        "CONFLICT",
        "The assertion could not be reviewed.",
      );
    await database.insert(evidenceAssertionReviews).values({
      id: newId(),
      workspaceId: context.workspaceId,
      assertionId: row.id,
      assertionVersion: updated.version,
      resourceVersion: relationship.version,
      state: input.state,
      reason,
      createdBy: context.actor.principalId,
    });
    const auditReference = await createAuditService(context).write(database, {
      action: "evidence.assertion.review",
      resourceKind: "evidence_assertion",
      resourceId: row.id,
      changedFields: ["reviewState"],
    });
    return {
      ...updated,
      auditReference,
      sourceReliability: evidence.sourceReliability,
      informationCredibility: updated.confidence,
    };
  });
}
export async function requireRelationshipPromotion(
  context: ResearchServiceContext,
  input: {
    id: string;
    version: number;
    state: string;
    nextState: string;
    reviewState: string;
    caseId: string | null;
    purpose: string | null | undefined;
    evidenceAssertionId?: string | null;
    explicitConfirmed?: boolean | null;
  },
) {
  if (
    !requiresRelationshipPromotionReview({
      from: input.state,
      to: input.nextState,
      reviewState: input.reviewState,
    })
  )
    return;
  if (!input.evidenceAssertionId || !input.explicitConfirmed)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "A confirmed reviewed assertion is required.",
    );
  const { row } = await requireAssertion(context, input.evidenceAssertionId);
  const [review] = await context.database
    .select()
    .from(evidenceAssertionReviews)
    .where(
      and(
        eq(evidenceAssertionReviews.workspaceId, context.workspaceId),
        eq(evidenceAssertionReviews.assertionId, row.id),
        eq(evidenceAssertionReviews.assertionVersion, row.version),
        eq(evidenceAssertionReviews.resourceVersion, input.version),
        eq(evidenceAssertionReviews.state, "approved"),
      ),
    )
    .limit(1);
  requireReviewedPromotion({
    from: input.state,
    to: input.nextState,
    reviewState: input.reviewState,
    reviewer:
      context.actor.type === "user" &&
      context.permissions.has("workspace:update"),
    assertionApproved:
      row.reviewState === "approved" &&
      row.role === "supports" &&
      row.resourceKind === "relationship" &&
      row.resourceId === input.id &&
      row.caseId === input.caseId &&
      row.purpose === input.purpose,
    approvalRecorded: !!review,
  });
}
