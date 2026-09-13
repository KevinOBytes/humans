import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  accessApprovals,
  breakGlassAccessRequests,
  breakGlassAccessResources,
} from "@/db/schema/governance";
import { facts } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import {
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { checkPurposeCoverage } from "./coverage";

type ApprovalBinding = {
  workspaceId: string;
  principalId: string;
  personId: string;
  fieldDefinitionId: string;
  purpose: string;
  caseReference: string | null;
  at: Date;
};
export function matchesRestrictedReadApproval(
  row: Omit<ApprovalBinding, "at"> & {
    scope: string;
    state: string;
    reviewedAt: Date | null;
    deletedAt: Date | null;
    expiresAt: Date | null;
  },
  input: ApprovalBinding,
) {
  return (
    row.workspaceId === input.workspaceId &&
    row.principalId === input.principalId &&
    row.personId === input.personId &&
    row.fieldDefinitionId === input.fieldDefinitionId &&
    row.purpose === input.purpose &&
    row.caseReference === input.caseReference &&
    row.scope === "restricted_read" &&
    row.state === "approved" &&
    row.reviewedAt !== null &&
    row.deletedAt === null &&
    row.expiresAt !== null &&
    row.expiresAt > input.at
  );
}

/** SQL prefilter for paged reads; the value-returning helper below also checks current consent. */
export function restrictedFactApprovalSql(
  context: ResearchServiceContext,
  row: {
    id: SQLWrapper;
    personId: SQLWrapper;
    factDefinitionId: SQLWrapper;
    sensitivity: SQLWrapper;
  },
) {
  return sql`(${row.sensitivity} <> 'restricted' OR EXISTS (
    SELECT 1 FROM ${accessApprovals}
    WHERE ${accessApprovals.workspaceId} = ${context.workspaceId}
      AND ${accessApprovals.principalId} = ${context.actor.principalId}
      AND ${accessApprovals.personId} = ${row.personId}
      AND ${accessApprovals.fieldDefinitionId} = ${row.factDefinitionId}
      AND ${accessApprovals.scope} = 'restricted_read'
      AND ${accessApprovals.state} = 'approved'
      AND ${accessApprovals.reviewedAt} IS NOT NULL
      AND ${accessApprovals.deletedAt} IS NULL
      AND ${accessApprovals.expiresAt} > ${new Date().toISOString()}::timestamptz
  ) OR EXISTS (
    SELECT 1
    FROM ${breakGlassAccessResources}
    INNER JOIN ${breakGlassAccessRequests}
      ON ${breakGlassAccessRequests.workspaceId} = ${breakGlassAccessResources.workspaceId}
     AND ${breakGlassAccessRequests.id} = ${breakGlassAccessResources.requestId}
    WHERE ${breakGlassAccessResources.workspaceId} = ${context.workspaceId}
      AND ${breakGlassAccessResources.resourceKind} = 'fact'
      AND ${breakGlassAccessResources.resourceId} = ${row.id}
      AND ${breakGlassAccessRequests.requesterPrincipalId} = ${context.actor.principalId}
      AND ${breakGlassAccessRequests.state} = 'approved'
      AND ${breakGlassAccessRequests.expiresAt} > ${new Date().toISOString()}::timestamptz
      AND ${breakGlassAccessRequests.deletedAt} IS NULL
  ))`;
}

/** Approval intersects fact/person visibility, permissions, and live consent; it never grants base access. */
export async function authorizeRestrictedFactRead(
  context: ResearchServiceContext,
  input: {
    factId: string;
    personId: string;
    fieldDefinitionId: string;
    purpose?: string;
    caseReference?: string | null;
  },
) {
  if (
    !context.permissions.has("fact:read") ||
    !context.permissions.has("person:read")
  )
    return false;
  const at = new Date();
  const [breakGlass] = await context.database
    .select({ request: breakGlassAccessRequests })
    .from(breakGlassAccessResources)
    .innerJoin(
      breakGlassAccessRequests,
      and(
        eq(
          breakGlassAccessRequests.workspaceId,
          breakGlassAccessResources.workspaceId,
        ),
        eq(breakGlassAccessRequests.id, breakGlassAccessResources.requestId),
      ),
    )
    .innerJoin(
      facts,
      and(
        eq(facts.workspaceId, breakGlassAccessResources.workspaceId),
        eq(facts.id, breakGlassAccessResources.resourceId),
      ),
    )
    .innerJoin(
      people,
      and(
        eq(people.workspaceId, facts.workspaceId),
        eq(people.id, facts.personId),
      ),
    )
    .where(
      and(
        eq(breakGlassAccessResources.workspaceId, context.workspaceId),
        eq(breakGlassAccessResources.resourceKind, "fact"),
        eq(breakGlassAccessResources.resourceId, input.factId),
        eq(
          breakGlassAccessRequests.requesterPrincipalId,
          context.actor.principalId,
        ),
        eq(breakGlassAccessRequests.state, "approved"),
        gt(breakGlassAccessRequests.expiresAt, at),
        isNull(breakGlassAccessRequests.deletedAt),
        isNull(facts.deletedAt),
        isNull(people.deletedAt),
        input.purpose === undefined
          ? undefined
          : eq(breakGlassAccessRequests.purpose, input.purpose),
        input.caseReference === undefined
          ? undefined
          : input.caseReference === null
            ? isNull(breakGlassAccessRequests.caseReference)
            : eq(breakGlassAccessRequests.caseReference, input.caseReference),
      ),
    )
    .orderBy(
      desc(breakGlassAccessRequests.createdAt),
      desc(breakGlassAccessRequests.id),
    )
    .limit(1);
  if (breakGlass) {
    const coverage = await checkPurposeCoverage(context, {
      personId: input.personId,
      fieldDefinitionId: input.fieldDefinitionId,
      purpose: breakGlass.request.purpose,
      caseReference: breakGlass.request.caseReference,
      scope: "restricted_read",
      effectiveSensitivity: "restricted",
      at,
    });
    if (coverage.allowed) {
      await createAuditService(context).write(context.database, {
        action: "governance.break_glass.use",
        resourceKind: "fact",
        resourceId: input.factId,
        changedFields: [],
      });
      return true;
    }
  }
  const candidates = await context.database
    .select({ approval: accessApprovals })
    .from(accessApprovals)
    .innerJoin(
      facts,
      and(
        eq(facts.workspaceId, accessApprovals.workspaceId),
        eq(facts.id, input.factId),
        eq(facts.personId, accessApprovals.personId),
        eq(facts.factDefinitionId, accessApprovals.fieldDefinitionId),
      ),
    )
    .innerJoin(
      people,
      and(
        eq(people.workspaceId, facts.workspaceId),
        eq(people.id, facts.personId),
      ),
    )
    .where(
      and(
        eq(accessApprovals.workspaceId, context.workspaceId),
        eq(accessApprovals.principalId, context.actor.principalId),
        eq(accessApprovals.personId, input.personId),
        eq(accessApprovals.fieldDefinitionId, input.fieldDefinitionId),
        eq(accessApprovals.scope, "restricted_read"),
        eq(accessApprovals.state, "approved"),
        isNotNull(accessApprovals.reviewedAt),
        gt(accessApprovals.expiresAt, at),
        isNull(accessApprovals.deletedAt),
        isNull(facts.deletedAt),
        isNull(people.deletedAt),
        resourceVisibilitySql(context, {
          resourceKind: "fact",
          id: facts.id,
          sensitivity: sql`'restricted'`,
        }),
        resourceVisibilitySql(context, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        }),
        input.purpose === undefined
          ? undefined
          : eq(accessApprovals.purpose, input.purpose),
        input.caseReference === undefined
          ? undefined
          : input.caseReference === null
            ? isNull(accessApprovals.caseReference)
            : eq(accessApprovals.caseReference, input.caseReference),
      ),
    )
    .orderBy(desc(accessApprovals.createdAt), desc(accessApprovals.id))
    .limit(100);
  for (const { approval } of candidates) {
    if (
      !matchesRestrictedReadApproval(approval, {
        ...input,
        workspaceId: context.workspaceId,
        principalId: context.actor.principalId,
        purpose: input.purpose ?? approval.purpose,
        caseReference:
          input.caseReference === undefined
            ? approval.caseReference
            : input.caseReference,
        at,
      })
    )
      continue;
    const coverage = await checkPurposeCoverage(context, {
      personId: input.personId,
      fieldDefinitionId: input.fieldDefinitionId,
      purpose: approval.purpose,
      caseReference: approval.caseReference,
      scope: "restricted_read",
      effectiveSensitivity: "restricted",
      at,
    });
    if (!coverage.allowed) continue;
    await createAuditService(context).write(context.database, {
      action: "governance.restricted_read",
      resourceKind: "fact",
      resourceId: input.factId,
      changedFields: [],
      metadata: {
        approvalId: approval.id,
        consentRecordId: coverage.consentRecordId,
        policyId: coverage.policyId,
      },
    });
    return true;
  }
  return false;
}
