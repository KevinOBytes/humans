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
import { accessApprovals } from "@/db/schema/governance";
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
