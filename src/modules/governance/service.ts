import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  accessApprovals,
  consentScopes,
  fieldPolicies,
  purposePolicies,
} from "@/db/schema/governance";
import { consentRecords } from "@/db/schema/privacy";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";

import { checkPurposeCoverage } from "./coverage";
import type { GovernanceScope, LawfulBasis } from "./types";
import { normalizeGovernanceInput, validateApprovalReason } from "./validation";

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
      purpose: unknown;
      lawfulBases: unknown;
      effectiveFrom: unknown;
      effectiveUntil?: unknown;
      caseReference?: unknown;
      metadata?: unknown;
      state?: "draft" | "active" | "disabled" | "archived";
    }) {
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
      purposePolicyId: string;
      fieldDefinitionId: string;
      permittedScopes: GovernanceScope[];
      sensitivityCeiling?:
        "public" | "internal" | "confidential" | "restricted";
      caseReference?: string | null;
    }) {
      administrative();
      if (!input.permittedScopes.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "At least one scope is required.",
        );
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
      personId: string;
      purpose: unknown;
      scopes: GovernanceScope[];
      lawfulBasis: unknown;
      effectiveFrom: unknown;
      effectiveUntil?: unknown;
      noticeVersion?: string | null;
      collectionMethod?: string | null;
      metadata?: unknown;
    }) {
      administrative();
      const normalized = normalizeGovernanceInput(input);
      if (!normalized.value)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The consent record is invalid.",
        );
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
        await tx
          .insert(consentScopes)
          .values(
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
      id: string;
      expectedVersion: number;
      withdrawalEffect?:
        "stop_processing" | "restrict_processing" | "retain_under_hold";
    }) {
      administrative();
      const [row] = await context.database.transaction(async (tx) => {
        const [updated] = await tx
          .update(consentRecords)
          .set({
            status: "withdrawn",
            withdrawnAt: new Date(),
            withdrawnBy: actor,
            withdrawalEffect: input.withdrawalEffect ?? "stop_processing",
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
      personId: string;
      fieldDefinitionId: string;
      purpose: string;
      reason: unknown;
      caseReference?: string | null;
      expiresAt?: Date | null;
    }) {
      const reason = validateApprovalReason(input.reason);
      if (!reason.value)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An approval reason is required.",
        );
      const [row] = await context.database.transaction(async (tx) => {
        const [created] = await tx
          .insert(accessApprovals)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            principalId: actor,
            personId: input.personId,
            fieldDefinitionId: input.fieldDefinitionId,
            purpose: input.purpose.trim().toLowerCase(),
            scope: "restricted_read",
            caseReference: input.caseReference ?? null,
            reason: reason.value!,
            expiresAt: input.expiresAt ?? null,
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
      id: string;
      expectedVersion: number;
      state: "approved" | "rejected" | "revoked";
      reason: unknown;
    }) {
      administrative();
      const reason = validateApprovalReason(input.reason);
      if (!reason.value)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An approval reason is required.",
        );
      const [row] = await context.database.transaction(async (tx) => {
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
      const rows = await context.database
        .select()
        .from(accessApprovals)
        .where(
          and(
            eq(accessApprovals.workspaceId, context.workspaceId),
            isNull(accessApprovals.deletedAt),
            after ? lt(accessApprovals.id, after.id) : undefined,
          ),
        )
        .orderBy(desc(accessApprovals.createdAt), desc(accessApprovals.id))
        .limit(page.first + 1);
      const nodes = rows.slice(0, page.first);
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
