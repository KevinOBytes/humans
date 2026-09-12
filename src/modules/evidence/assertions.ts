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
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
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
  idempotencyKey?: string | null;
};

type AssertionReference = ResearchResponseReference &
  Readonly<{ assertionId: string; auditReference: string }>;

const ASSERTION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function referenceUuid(
  reference: ResearchResponseReference,
  key: "assertionId" | "auditReference",
  label: string,
): string {
  const value = reference[key];
  if (typeof value !== "string" || !UUID.test(value))
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      `The stored ${label} mutation result is invalid.`,
    );
  return value.toLowerCase();
}

function idempotency(
  context: ResearchServiceContext,
  input: {
    key: string;
    operation: string;
    material: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
) {
  if (!context.idempotencyHmacKey)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Evidence assertion idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + ASSERTION_IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.key,
    operation: input.operation,
    requestMaterial: input.material,
    secret: context.idempotencyHmacKey,
  });
}

async function replayAssertion(
  context: ResearchServiceContext,
  reference: ResearchResponseReference,
) {
  const assertionId = referenceUuid(reference, "assertionId", "assertion");
  const auditReference = referenceUuid(
    reference,
    "auditReference",
    "assertion",
  );
  const { row, evidence } = await requireAssertion(context, assertionId);
  return {
    ...row,
    auditReference,
    sourceReliability: evidence.sourceReliability,
    informationCredibility: row.confidence,
  };
}

function requireIndependentReviewer(
  context: ResearchServiceContext,
  createdBy: string,
) {
  if (context.actor.type !== "user" || createdBy === context.actor.principalId)
    throw createGraphQLError(
      "FORBIDDEN",
      "An independent reviewer is required.",
    );
}
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
  if (input.idempotencyKey != null) {
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      idempotency(context, {
        key: input.idempotencyKey,
        operation: "evidence.assertion.link.graphql",
        material: {
          caseId: input.caseId ?? null,
          confidence: normalized.confidence,
          evidenceId: input.evidenceId,
          explicitConfirmed: input.explicitConfirmed,
          locator: normalized.locator,
          quote: normalized.quote,
          purpose: governance.governancePurpose!,
          resourceId: input.resourceId,
          resourceKind: normalized.resourceKind,
          role: normalized.role,
        },
      }),
      [
        "evidence:update",
        "evidence:read",
        "source:read",
        `${normalized.resourceKind}:update`,
        `${normalized.resourceKind}:read`,
        "person:read",
        "workspace:read",
      ],
      async (scopedContext): Promise<AssertionReference> => {
        const row = await linkEvidenceAssertion(scopedContext, {
          ...input,
          idempotencyKey: null,
        });
        return {
          assertionId: row.id,
          auditReference: row.auditReference,
        };
      },
    );
    return replayAssertion(context, executed.responseReference);
  }
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
  input: {
    id: string;
    expectedVersion: number;
    state: string;
    reason: string;
    idempotencyKey?: string | null;
  },
) {
  permitted(context, "workspace:update");
  permitted(context, "evidence:update");
  if (!["approved", "rejected"].includes(input.state))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The review state is invalid.",
    );
  const reason = boundedCaseText(input.reason, 2000);
  if (input.idempotencyKey != null) {
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      idempotency(context, {
        key: input.idempotencyKey,
        operation: "evidence.assertion.review.graphql",
        material: {
          expectedVersion: input.expectedVersion,
          id: input.id,
          reason,
          state: input.state,
        },
      }),
      [
        "workspace:update",
        "workspace:read",
        "evidence:update",
        "evidence:read",
        "source:read",
        "person:read",
        "relationship:read",
      ],
      async (scopedContext): Promise<AssertionReference> => {
        const row = await reviewEvidenceAssertion(scopedContext, {
          ...input,
          idempotencyKey: null,
        });
        return {
          assertionId: row.id,
          auditReference: row.auditReference,
        };
      },
    );
    const replayed = await replayAssertion(context, executed.responseReference);
    requireIndependentReviewer(context, replayed.createdBy);
    return replayed;
  }
  return withResearchWriteTransaction(context, async (database) => {
    const scoped = { ...context, database };
    const { row, evidence } = await requireAssertion(scoped, input.id);
    // An independent human reviewer, not an API key or the assertion author.
    requireIndependentReviewer(context, row.createdBy);
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
