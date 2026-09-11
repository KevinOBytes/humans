import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  accessApprovals,
  consentScopes,
  fieldPolicies,
  purposePolicies,
} from "@/db/schema/governance";
import { consentRecords } from "@/db/schema/privacy";
import { people } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import {
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";

import { checkPurposeCoverage } from "./coverage";
import type { GovernanceScope, LawfulBasis } from "./types";
import {
  approvalTransitionSource,
  normalizeGovernanceContext,
  normalizeGovernanceInput,
  validateApprovalReason,
} from "./validation";

const GOVERNANCE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const internalGovernanceIdempotencyKey = Symbol("governance-idempotency");
type GovernanceIdempotencyKey =
  string | typeof internalGovernanceIdempotencyKey;
type PurposePolicyRow = typeof purposePolicies.$inferSelect;
type FieldPolicyRow = typeof fieldPolicies.$inferSelect;
type ConsentRecordRow = typeof consentRecords.$inferSelect;
type AccessApprovalRow = typeof accessApprovals.$inferSelect;

function governanceIdempotency(
  context: ResearchServiceContext,
  input: {
    idempotencyKey: GovernanceIdempotencyKey;
    operation: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
) {
  if (input.idempotencyKey === internalGovernanceIdempotencyKey) return null;
  if (!context.idempotencyHmacKey)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Governance mutation idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + GOVERNANCE_IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.idempotencyKey,
    operation: input.operation,
    requestMaterial: input.requestMaterial,
    secret: context.idempotencyHmacKey,
  });
}

function governanceMutationId(reference: ResearchResponseReference) {
  const id = reference.governanceMutationId;
  if (typeof id !== "string")
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored governance mutation result is invalid.",
    );
  return id;
}

function unavailableGovernanceResult() {
  throw createGraphQLError(
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}

async function replayPurposePolicy(
  context: ResearchServiceContext,
  id: string,
) {
  const [row] = await context.database
    .select()
    .from(purposePolicies)
    .where(
      and(
        eq(purposePolicies.workspaceId, context.workspaceId),
        eq(purposePolicies.id, id),
        isNull(purposePolicies.deletedAt),
      ),
    )
    .limit(1);
  return row ?? unavailableGovernanceResult();
}

async function replayFieldPolicy(context: ResearchServiceContext, id: string) {
  const [row] = await context.database
    .select()
    .from(fieldPolicies)
    .where(
      and(
        eq(fieldPolicies.workspaceId, context.workspaceId),
        eq(fieldPolicies.id, id),
        isNull(fieldPolicies.deletedAt),
      ),
    )
    .limit(1);
  return row ?? unavailableGovernanceResult();
}

async function replayVisibleConsent(
  context: ResearchServiceContext,
  id: string,
) {
  const [row] = await context.database
    .select({ consent: consentRecords })
    .from(consentRecords)
    .innerJoin(
      people,
      and(
        eq(people.workspaceId, consentRecords.workspaceId),
        eq(people.id, consentRecords.personId),
      ),
    )
    .where(
      and(
        eq(consentRecords.workspaceId, context.workspaceId),
        eq(consentRecords.id, id),
        isNull(consentRecords.deletedAt),
        isNull(people.deletedAt),
        resourceVisibilitySql(context, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        }),
      ),
    )
    .limit(1);
  return row?.consent ?? unavailableGovernanceResult();
}

async function replayVisibleApproval(
  context: ResearchServiceContext,
  id: string,
) {
  const [row] = await context.database
    .select({ approval: accessApprovals })
    .from(accessApprovals)
    .innerJoin(
      people,
      and(
        eq(people.workspaceId, accessApprovals.workspaceId),
        eq(people.id, accessApprovals.personId),
      ),
    )
    .where(
      and(
        eq(accessApprovals.workspaceId, context.workspaceId),
        eq(accessApprovals.id, id),
        isNull(accessApprovals.deletedAt),
        isNull(people.deletedAt),
        resourceVisibilitySql(context, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        }),
      ),
    )
    .limit(1);
  return row?.approval ?? unavailableGovernanceResult();
}

async function requireVisiblePerson(
  context: ResearchServiceContext,
  personId: string,
) {
  const [visiblePerson] = await context.database
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, context.workspaceId),
        eq(people.id, personId),
        isNull(people.deletedAt),
        resourceVisibilitySql(context, {
          resourceKind: "person",
          id: people.id,
          sensitivity: people.sensitivity,
        }),
      ),
    )
    .limit(1);
  if (!visiblePerson) unavailableGovernanceResult();
}

function cursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}

function parseCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      t: string;
      i: string;
    };
    const createdAt = new Date(parsed.t);
    return typeof parsed.i === "string" && !Number.isNaN(createdAt.getTime())
      ? { createdAt, id: parsed.i }
      : null;
  } catch {
    return null;
  }
}

export function createGovernanceService(context: ResearchServiceContext) {
  const audit = createAuditService(context);
  const actor = context.actor.principalId;
  const administrative = () => {
    if (!context.permissions.has("workspace:update")) {
      throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
    }
  };
  return {
    async createPurposePolicy(input: {
      idempotencyKey: GovernanceIdempotencyKey;
      purpose: unknown;
      lawfulBases: unknown;
      effectiveFrom: unknown;
      effectiveUntil?: unknown;
      caseReference?: unknown;
      metadata?: unknown;
      state?: "draft" | "active" | "disabled" | "archived";
    }): Promise<PurposePolicyRow> {
      administrative();
      const normalized = normalizeGovernanceInput({
        purpose: input.purpose,
        scopes: ["read"],
        lawfulBasis: Array.isArray(input.lawfulBases)
          ? input.lawfulBases[0]
          : input.lawfulBases,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil,
        metadata: input.metadata,
      });
      if (
        !normalized.value ||
        !Array.isArray(input.lawfulBases) ||
        !input.lawfulBases.length
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The purpose policy is invalid.",
        );
      }
      const bases = input.lawfulBases
        .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
        .filter((value): value is LawfulBasis =>
          [
            "consent",
            "contract",
            "legal_obligation",
            "vital_interests",
            "public_task",
            "legitimate_interests",
          ].includes(value),
        );
      if (!bases.length || bases.length !== input.lawfulBases.length) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The purpose policy is invalid.",
        );
      }
      const idempotency = governanceIdempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.purpose_policy.create",
        requestMaterial: {
          caseReference:
            typeof input.caseReference === "string"
              ? input.caseReference.trim() || null
              : null,
          effectiveFrom: normalized.value.effectiveFrom?.toISOString() ?? null,
          effectiveUntil:
            normalized.value.effectiveUntil?.toISOString() ?? null,
          lawfulBases: [...new Set(bases)].sort(),
          metadata: (normalized.value.metadata ??
            {}) as CanonicalRequestMaterial,
          purpose: normalized.value.purpose,
          state: input.state ?? "draft",
        },
      });
      if (idempotency) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["workspace:update"],
          async (scopedContext) => ({
            governanceMutationId: (
              await createGovernanceService(scopedContext).createPurposePolicy({
                ...input,
                idempotencyKey: internalGovernanceIdempotencyKey,
              })
            ).id,
          }),
        );
        return replayPurposePolicy(
          context,
          governanceMutationId(executed.responseReference),
        );
      }
      const [row] = await context.database.transaction(async (tx) => {
        const [created] = await tx
          .insert(purposePolicies)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            purpose: normalized.value!.purpose,
            lawfulBases: [...new Set(bases)],
            effectiveFrom: normalized.value!.effectiveFrom ?? new Date(),
            effectiveUntil: normalized.value!.effectiveUntil,
            metadata: normalized.value!.metadata,
            caseReference:
              typeof input.caseReference === "string"
                ? input.caseReference.trim() || null
                : null,
            state: input.state ?? "draft",
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        if (!created) throw new Error("Purpose policy insert failed");
        await audit.write(tx, {
          action: "governance.purpose_policy.create",
          changedFields: ["purpose", "lawfulBases"],
          resourceKind: "purpose_policy",
          resourceId: created.id,
        });
        return [created];
      });
      return row!;
    },
    async setFieldPolicy(input: {
      idempotencyKey: GovernanceIdempotencyKey;
      purposePolicyId: string;
      fieldDefinitionId: string;
      permittedScopes: GovernanceScope[];
      sensitivityCeiling?:
        "public" | "internal" | "confidential" | "restricted";
      caseReference?: string | null;
    }): Promise<FieldPolicyRow> {
      administrative();
      if (!input.permittedScopes.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "At least one scope is required.",
        );
      const idempotency = governanceIdempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.field_policy.create",
        requestMaterial: {
          caseReference: input.caseReference?.trim() || null,
          fieldDefinitionId: input.fieldDefinitionId,
          permittedScopes: [...new Set(input.permittedScopes)].sort(),
          purposePolicyId: input.purposePolicyId,
          sensitivityCeiling: input.sensitivityCeiling ?? "internal",
        },
      });
      if (idempotency) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["workspace:update"],
          async (scopedContext) => ({
            governanceMutationId: (
              await createGovernanceService(scopedContext).setFieldPolicy({
                ...input,
                idempotencyKey: internalGovernanceIdempotencyKey,
              })
            ).id,
          }),
        );
        return replayFieldPolicy(
          context,
          governanceMutationId(executed.responseReference),
        );
      }
      const [row] = await context.database.transaction(async (tx) => {
        const [created] = await tx
          .insert(fieldPolicies)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            purposePolicyId: input.purposePolicyId,
            fieldDefinitionId: input.fieldDefinitionId,
            permittedScopes: [...new Set(input.permittedScopes)],
            sensitivityCeiling: input.sensitivityCeiling ?? "internal",
            caseReference: input.caseReference ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        if (!created) throw new Error("Field policy insert failed");
        await audit.write(tx, {
          action: "governance.field_policy.set",
          changedFields: ["permittedScopes"],
          resourceKind: "field_policy",
          resourceId: created.id,
        });
        return [created];
      });
      return row!;
    },
    async recordConsent(input: {
      idempotencyKey: GovernanceIdempotencyKey;
      personId: string;
      purpose: unknown;
      scopes: GovernanceScope[];
      lawfulBasis: unknown;
      effectiveFrom: unknown;
      effectiveUntil?: unknown;
      noticeVersion?: string | null;
      collectionMethod?: string | null;
      metadata?: unknown;
    }): Promise<ConsentRecordRow> {
      administrative();
      const normalized = normalizeGovernanceInput(input);
      if (!normalized.value)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The consent record is invalid.",
        );
      await requireVisiblePerson(context, input.personId);
      const idempotency = governanceIdempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.consent.record",
        requestMaterial: {
          collectionMethod: input.collectionMethod?.trim() || null,
          effectiveFrom: normalized.value.effectiveFrom?.toISOString() ?? null,
          effectiveUntil:
            normalized.value.effectiveUntil?.toISOString() ?? null,
          lawfulBasis: normalized.value.lawfulBasis,
          metadata: (normalized.value.metadata ??
            {}) as CanonicalRequestMaterial,
          noticeVersion: input.noticeVersion?.trim() || null,
          personId: input.personId,
          purpose: normalized.value.purpose,
          scopes: [...normalized.value.scopes].sort(),
        },
      });
      if (idempotency) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["workspace:update", "person:read"],
          async (scopedContext) => ({
            governanceMutationId: (
              await createGovernanceService(scopedContext).recordConsent({
                ...input,
                idempotencyKey: internalGovernanceIdempotencyKey,
              })
            ).id,
          }),
        );
        return replayVisibleConsent(
          context,
          governanceMutationId(executed.responseReference),
        );
      }
      const [row] = await context.database.transaction(async (tx) => {
        const [created] = await tx
          .insert(consentRecords)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            personId: input.personId,
            purpose: normalized.value!.purpose,
            status: "granted",
            source: input.collectionMethod?.trim() || "recorded",
            effectiveFrom: normalized.value!.effectiveFrom ?? new Date(),
            effectiveUntil: normalized.value!.effectiveUntil,
            noticeVersion: input.noticeVersion?.trim() || null,
            collectionMethod: input.collectionMethod?.trim() || null,
            lawfulBasis: normalized.value!.lawfulBasis,
            lawfulBasisMetadata: normalized.value!.metadata,
            version: 1,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        if (!created) throw new Error("Consent insert failed");
        await tx.insert(consentScopes).values(
          normalized.value!.scopes.map((scope) => ({
            id: newId(),
            workspaceId: context.workspaceId,
            consentRecordId: created.id,
            purpose: created.purpose,
            scope,
            createdBy: actor,
            updatedBy: actor,
          })),
        );
        await audit.write(tx, {
          action: "governance.consent.record",
          changedFields: ["purpose", "scope", "lawfulBasis"],
          resourceKind: "consent_record",
          resourceId: created.id,
        });
        return [created];
      });
      return row!;
    },
    async withdrawConsent(input: {
      idempotencyKey: GovernanceIdempotencyKey;
      id: string;
      expectedVersion: number;
      withdrawalEffect?:
        "stop_processing" | "restrict_processing" | "retain_under_hold";
    }): Promise<ConsentRecordRow> {
      administrative();
      const withdrawalEffect = input.withdrawalEffect ?? "stop_processing";
      const idempotency = governanceIdempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.consent.withdraw",
        requestMaterial: {
          expectedVersion: input.expectedVersion,
          id: input.id,
          withdrawalEffect,
        },
      });
      if (idempotency) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["workspace:update", "person:read"],
          async (scopedContext) => ({
            governanceMutationId: (
              await createGovernanceService(scopedContext).withdrawConsent({
                ...input,
                idempotencyKey: internalGovernanceIdempotencyKey,
                withdrawalEffect,
              })
            ).id,
          }),
        );
        return replayVisibleConsent(
          context,
          governanceMutationId(executed.responseReference),
        );
      }
      const [row] = await context.database.transaction(async (tx) => {
        // Consent records are themselves sensitive subject data.  Keep this
        // mutation subject-scoped so a workspace administrator cannot use an
        // opaque consent UUID to mutate a person outside their record-level
        // visibility grants.  The conflict response intentionally does not
        // distinguish an unknown, deleted, cross-workspace, or hidden row.
        const [visibleConsent] = await tx
          .select({ id: consentRecords.id })
          .from(consentRecords)
          .innerJoin(
            people,
            and(
              eq(people.workspaceId, consentRecords.workspaceId),
              eq(people.id, consentRecords.personId),
            ),
          )
          .where(
            and(
              eq(consentRecords.workspaceId, context.workspaceId),
              eq(consentRecords.id, input.id),
              isNull(consentRecords.deletedAt),
              isNull(people.deletedAt),
              resourceVisibilitySql(context, {
                resourceKind: "person",
                id: people.id,
                sensitivity: people.sensitivity,
              }),
            ),
          )
          .limit(1);
        if (!visibleConsent)
          throw createGraphQLError(
            "CONFLICT",
            "The consent record could not be withdrawn.",
          );
        const [updated] = await tx
          .update(consentRecords)
          .set({
            status: "withdrawn",
            withdrawnAt: new Date(),
            withdrawnBy: actor,
            withdrawalEffect,
            updatedAt: new Date(),
            updatedBy: actor,
            version: sql`${consentRecords.version} + 1`,
          })
          .where(
            and(
              eq(consentRecords.workspaceId, context.workspaceId),
              eq(consentRecords.id, input.id),
              eq(consentRecords.version, input.expectedVersion),
              isNull(consentRecords.deletedAt),
            ),
          )
          .returning();
        if (!updated)
          throw createGraphQLError(
            "CONFLICT",
            "The consent record could not be withdrawn.",
          );
        await audit.write(tx, {
          action: "governance.consent.withdraw",
          changedFields: ["status", "withdrawalEffect"],
          resourceKind: "consent_record",
          resourceId: updated.id,
        });
        return [updated];
      });
      return row!;
    },
    getCoverage(input: Parameters<typeof checkPurposeCoverage>[1]) {
      return checkPurposeCoverage(context, input);
    },
    async requestApproval(input: {
      idempotencyKey: GovernanceIdempotencyKey;
      personId: string;
      fieldDefinitionId: string;
      purpose: string;
      reason: unknown;
      caseReference?: string | null;
      expiresAt?: Date | null;
    }): Promise<AccessApprovalRow> {
      if (!context.permissions.has("person:read")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "This operation is not permitted.",
        );
      }
      const reason = validateApprovalReason(input.reason);
      const governance = normalizeGovernanceContext({
        governancePurpose: input.purpose,
        governanceCaseReference: input.caseReference,
      });
      const [visiblePerson] = await context.database
        .select({ id: people.id })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, context.workspaceId),
            eq(people.id, input.personId),
            isNull(people.deletedAt),
            resourceVisibilitySql(context, {
              resourceKind: "person",
              id: people.id,
              sensitivity: people.sensitivity,
            }),
          ),
        )
        .limit(1);
      if (!visiblePerson)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      if (!reason.value)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An approval reason is required.",
        );
      const expiresAt =
        input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
      const idempotency = governanceIdempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.approval.request",
        requestMaterial: {
          caseReference: governance.governanceCaseReference,
          // The default expiry is server-generated and must not make a retry
          // with the same caller key conflict merely because the wall clock
          // advanced. An explicitly supplied expiry remains part of the
          // caller's request material and is therefore conflict-bound.
          expiresAt: input.expiresAt?.toISOString() ?? null,
          fieldDefinitionId: input.fieldDefinitionId,
          personId: input.personId,
          purpose: governance.governancePurpose!,
          reason: reason.value,
        },
      });
      if (idempotency) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:read"],
          async (scopedContext) => ({
            governanceMutationId: (
              await createGovernanceService(scopedContext).requestApproval({
                ...input,
                expiresAt,
                idempotencyKey: internalGovernanceIdempotencyKey,
              })
            ).id,
          }),
        );
        return replayVisibleApproval(
          context,
          governanceMutationId(executed.responseReference),
        );
      }
      const [row] = await context.database.transaction(async (tx) => {
        const [created] = await tx
          .insert(accessApprovals)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            principalId: actor,
            personId: input.personId,
            fieldDefinitionId: input.fieldDefinitionId,
            purpose: governance.governancePurpose!,
            scope: "restricted_read",
            caseReference: governance.governanceCaseReference,
            reason: reason.value!,
            expiresAt,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        if (!created) throw new Error("Approval insert failed");
        await audit.write(tx, {
          action: "governance.approval.request",
          changedFields: ["reason"],
          resourceKind: "access_approval",
          resourceId: created.id,
        });
        return [created];
      });
      return row!;
    },
    async reviewApproval(input: {
      idempotencyKey: GovernanceIdempotencyKey;
      id: string;
      expectedVersion: number;
      state: "approved" | "rejected" | "revoked";
      reason: unknown;
    }): Promise<AccessApprovalRow> {
      administrative();
      const fromState = approvalTransitionSource(input.state);
      const reason = validateApprovalReason(input.reason);
      if (!reason.value)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An approval reason is required.",
        );
      const idempotency = governanceIdempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.approval.review",
        requestMaterial: {
          expectedVersion: input.expectedVersion,
          id: input.id,
          reason: reason.value,
          state: input.state,
        },
      });
      if (idempotency) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["workspace:update", "person:read"],
          async (scopedContext) => ({
            governanceMutationId: (
              await createGovernanceService(scopedContext).reviewApproval({
                ...input,
                idempotencyKey: internalGovernanceIdempotencyKey,
                reason: reason.value,
              })
            ).id,
          }),
        );
        return replayVisibleApproval(
          context,
          governanceMutationId(executed.responseReference),
        );
      }
      const [row] = await context.database.transaction(async (tx) => {
        // Approval review is an independent control.  Require visibility of
        // the subject as well as a reviewer other than the requesting
        // principal before permitting any state transition.  A single
        // conflict response prevents callers from probing either condition.
        const [visibleApproval] = await tx
          .select({
            id: accessApprovals.id,
            createdBy: accessApprovals.createdBy,
          })
          .from(accessApprovals)
          .innerJoin(
            people,
            and(
              eq(people.workspaceId, accessApprovals.workspaceId),
              eq(people.id, accessApprovals.personId),
            ),
          )
          .where(
            and(
              eq(accessApprovals.workspaceId, context.workspaceId),
              eq(accessApprovals.id, input.id),
              isNull(accessApprovals.deletedAt),
              isNull(people.deletedAt),
              resourceVisibilitySql(context, {
                resourceKind: "person",
                id: people.id,
                sensitivity: people.sensitivity,
              }),
            ),
          )
          .limit(1);
        if (!visibleApproval || visibleApproval.createdBy === actor)
          throw createGraphQLError(
            "CONFLICT",
            "The approval could not be reviewed.",
          );
        const [updated] = await tx
          .update(accessApprovals)
          .set({
            state: input.state,
            reviewedAt: new Date(),
            reviewedBy: actor,
            reviewReason: reason.value!,
            updatedAt: new Date(),
            updatedBy: actor,
            version: sql`${accessApprovals.version} + 1`,
          })
          .where(
            and(
              eq(accessApprovals.workspaceId, context.workspaceId),
              eq(accessApprovals.id, input.id),
              eq(accessApprovals.version, input.expectedVersion),
              eq(accessApprovals.state, fromState),
              ne(accessApprovals.createdBy, actor),
              isNull(accessApprovals.deletedAt),
            ),
          )
          .returning();
        if (!updated)
          throw createGraphQLError(
            "CONFLICT",
            "The approval could not be reviewed.",
          );
        await audit.write(tx, {
          action: "governance.approval.review",
          changedFields: ["state", "reviewReason"],
          resourceKind: "access_approval",
          resourceId: updated.id,
        });
        return [updated];
      });
      return row!;
    },
    async listApprovals(
      input: { first?: number | null; after?: string | null } = {},
    ) {
      const page = normalizePagination(input);
      const after = parseCursor(page.after);
      if (page.after && !after)
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      if (!context.permissions.has("person:read"))
        throw createGraphQLError(
          "FORBIDDEN",
          "This operation is not permitted.",
        );
      const rows = await context.database
        .select({ approval: accessApprovals })
        .from(accessApprovals)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, accessApprovals.workspaceId),
            eq(people.id, accessApprovals.personId),
          ),
        )
        .where(
          and(
            eq(accessApprovals.workspaceId, context.workspaceId),
            isNull(accessApprovals.deletedAt),
            isNull(people.deletedAt),
            context.permissions.has("workspace:update")
              ? undefined
              : eq(accessApprovals.principalId, actor),
            resourceVisibilitySql(context, {
              resourceKind: "person",
              id: people.id,
              sensitivity: people.sensitivity,
            }),
            after
              ? or(
                  lt(accessApprovals.createdAt, after.createdAt),
                  and(
                    eq(accessApprovals.createdAt, after.createdAt),
                    lt(accessApprovals.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(accessApprovals.createdAt), desc(accessApprovals.id))
        .limit(page.first + 1);
      const nodes = rows.slice(0, page.first).map((row) => row.approval);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: nodes.at(-1) ? cursor(nodes.at(-1)!) : null,
        },
      };
    },
  };
}

export type GovernanceService = ReturnType<typeof createGovernanceService>;
