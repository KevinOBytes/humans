import { and, eq, isNull, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { GraphQLError } from "graphql";
import { newId } from "@/db/id";
import {
  evidenceAssertions,
  evidenceAssertionReviews,
  evidenceItems,
  sources,
} from "@/db/schema/evidence";
import { relationships } from "@/db/schema/relationships";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination, type PaginationInput } from "@/graphql/limits";
import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import {
  canAccessResource,
  resourceVisibilitySql,
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction,
  runResearchTransaction,
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
  parseIdentifierCitationPath,
  requireReviewedPromotion,
  requiresRelationshipPromotionReview,
} from "./assertions-validation";
import { requireIdentifierCitation } from "./identifier-citations";
import { createEvidenceRepository } from "./repository";

type AssertionInput = {
  evidenceId: string;
  resourceKind: string;
  resourceId: string;
  fieldPath?: string | null;
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
  return withResearchWriteTransaction(context, async (database) => {
    const { row, evidence } = await requireAssertion(
      { ...context, database },
      assertionId,
    );
    return {
      ...row,
      auditReference,
      sourceReliability: evidence.sourceReliability,
      informationCredibility: row.confidence,
    };
  });
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
    listPersonIdentifierCitations: (
      input: { personId: string } & PaginationInput,
    ) => listPersonIdentifierCitations(context, input),
    link: (input: AssertionInput) => linkEvidenceAssertion(context, input),
    review: (input: Parameters<typeof reviewEvidenceAssertion>[1]) =>
      reviewEvidenceAssertion(context, input),
  };
}
export type EvidenceAssertionsService = ReturnType<
  typeof createEvidenceAssertionsService
>;

export type PersonIdentifierCitation = {
  id: string;
  evidenceId: string;
  identifierId: string;
  identifierVersion: number;
  field: string;
  fieldPath: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  locator: string;
  quote: string;
  role: string;
  confidence: string;
  sourceReliability: string | null;
  reviewState: string;
};

async function listPersonIdentifierCitations(
  context: ResearchServiceContext,
  input: { personId: string } & PaginationInput,
) {
  const page = normalizePagination(input);
  // Seal, rather than merely encode, scan positions: omitted rows must not leak
  // their UUIDs through a cursor. The key and envelope are purpose-separated.
  if (!context.idempotencyHmacKey)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Citation pagination is not configured.",
    );
  const key = createHmac(
    "sha256",
    Buffer.from(context.idempotencyHmacKey, "hex"),
  )
    .update("humans:identifier-citation-cursor:v1")
    .digest("hex");
  const purpose = "identifier-citation-cursor";
  const binding = {
    workspaceId: context.workspaceId,
    personId: input.personId,
    principalId: context.actor.principalId,
  };
  let afterId: string | null = null;
  if (page.after != null) {
    try {
      if (page.after.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(page.after))
        throw new Error();
      const bytes = Buffer.from(page.after, "base64url");
      if (bytes.toString("base64url") !== page.after) throw new Error();
      const decoded = JSON.parse(
        openSealedEnvelope({ key, purpose, token: bytes.toString("utf8") }),
      );
      if (
        decoded.v !== 1 ||
        decoded.workspaceId !== binding.workspaceId ||
        decoded.personId !== binding.personId ||
        decoded.principalId !== binding.principalId ||
        typeof decoded.id !== "string" ||
        !UUID.test(decoded.id)
      )
        throw new Error();
      afterId = decoded.id;
    } catch {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The citation cursor is invalid.",
      );
    }
  }
  return runResearchTransaction(
    context,
    { requiredPermissions: ["person:read", "evidence:read", "source:read"] },
    async (scoped) => {
      const person = await requireCaseResource(
        scoped,
        "person",
        input.personId,
      );
      const rows = await createEvidenceRepository(
        scoped.database,
      ).listPersonIdentifierCitationCandidates({
        workspaceId: scoped.workspaceId,
        personId: input.personId,
        afterId,
        limit: page.first + 1,
        evidenceVisibility: resourceVisibilitySql(scoped, {
          resourceKind: "evidence",
          id: evidenceItems.id,
          sensitivity: evidenceItems.sensitivity,
        }),
        sourceVisibility: resourceVisibilitySql(scoped, {
          resourceKind: "source",
          id: sources.id,
          sensitivity: sources.sensitivity,
        }),
      });
      const candidates = rows.slice(0, page.first);
      const nodes: PersonIdentifierCitation[] = [];
      for (const row of candidates) {
        try {
          const citation = parseIdentifierCitationPath(
            row.resourceKind,
            row.fieldPath,
          );
          if (!citation) continue;
          // Locks parent then identifier and rechecks public sensitivity/current
          // version. Historical citations are not silently rebound to new values.
          await requireIdentifierCitation(scoped, row, true);
          if (row.caseId) {
            const caseRow = await createCasesService(scoped).getCase(
              row.caseId,
            );
            if (caseRow.purpose !== row.purpose) continue;
          }
          await requireResourceCoverage(
            scoped,
            person,
            row.purpose,
            row.caseId,
            "read",
          );
          await requireEvidence(scoped, row.evidenceId);
          let sourceUrl: string | null = null;
          if (row.sourceUrl) {
            try {
              const url = new URL(row.sourceUrl);
              if (
                ["http:", "https:"].includes(url.protocol) &&
                !url.username &&
                !url.password
              )
                sourceUrl = url.href;
            } catch {}
          }
          nodes.push({
            id: row.id,
            evidenceId: row.evidenceId,
            identifierId: citation.identifierId,
            identifierVersion: citation.version,
            field: citation.field,
            fieldPath: row.fieldPath!,
            sourceId: row.sourceId,
            sourceTitle: row.sourceTitle.slice(0, 512),
            sourceUrl,
            locator: row.locator.slice(0, 2048),
            quote: row.quote.slice(0, 8000),
            role: row.role,
            confidence: row.confidence,
            sourceReliability: row.sourceReliability,
            reviewState: row.reviewState,
          });
        } catch (error) {
          if (
            !(error instanceof GraphQLError) ||
            ![
              "NOT_FOUND",
              "FORBIDDEN",
              "PRECONDITION_FAILED",
              "CONFLICT",
              "VALIDATION_FAILED",
            ].includes(String(error.extensions.code))
          )
            throw error;
        }
      }
      const last = candidates.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? Buffer.from(
                sealEnvelope({
                  key,
                  purpose,
                  plaintext: JSON.stringify({ v: 1, ...binding, id: last.id }),
                }),
              ).toString("base64url")
            : null,
        },
      };
    },
  );
}
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
  await requireIdentifierCitation(context, row, false);
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
          fieldPath: normalized.fieldPath,
          locator: normalized.locator,
          quote: normalized.quote,
          purpose: governance.governancePurpose!,
          resourceId: input.resourceId,
          resourceKind: normalized.resourceKind,
          role: normalized.role,
        },
      }),
      [
        ...new Set([
          "evidence:update",
          "evidence:read",
          "source:read",
          `${normalized.resourceKind}:update`,
          `${normalized.resourceKind}:read`,
          "person:read",
          "workspace:read",
        ]),
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
    await requireIdentifierCitation(
      scoped,
      {
        resourceKind: normalized.resourceKind,
        resourceId: input.resourceId,
        fieldPath: normalized.fieldPath,
      },
      true,
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
      changedFields: ["fieldPath", "locator", "quote", "role", "confidence"],
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
