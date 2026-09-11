import "server-only";

import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { caseMembers, cases } from "@/db/schema/cases";
import { exportApprovals } from "@/db/schema/export-approvals";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
import { createCasesRepository } from "@/modules/cases/repository";
import { createCasesService } from "@/modules/cases/service";

import type { ExportRedactionProfile } from "./preview";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MAX_APPROVAL_LIFETIME_MS = 60 * 60_000;
const internalIdempotencyKey = Symbol("export-approval-idempotency");
type IdempotencyKey = string | typeof internalIdempotencyKey;
type ExportApprovalRow = typeof exportApprovals.$inferSelect;

export type ExportApprovalProjection = Readonly<{
  id: string;
  workspaceId: string;
  caseId: string | null;
  purpose: string;
  previewHash: string;
  redactionProfile: ExportRedactionProfile;
  requestedByPrincipalId: string;
  reviewedByPrincipalId: string | null;
  state: "requested" | "approved" | "rejected";
  requestReason: string;
  decisionReason: string | null;
  expiresAt: Date;
  reviewedAt: Date | null;
  requestAuditReference: string;
  reviewAuditReference: string | null;
  version: number;
  createdAt: Date;
}>;

type Binding = Readonly<{
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  redactionProfile: ExportRedactionProfile;
  previewHash: string;
}>;

function forbidden(): never {
  throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
}

function precondition(): never {
  throw createGraphQLError(
    "PRECONDITION_FAILED",
    "A current reviewed export approval is required.",
  );
}

function normalizeText(value: unknown, label: string, maximum: number): string {
  const normalized =
    typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw createGraphQLError("VALIDATION_FAILED", `${label} is invalid.`);
  }
  return normalized;
}

function normalizeHash(value: unknown): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/u.test(normalized))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The export preview hash is invalid.",
    );
  return normalized;
}

function normalizeProfile(value: unknown): ExportRedactionProfile {
  if (
    value !== "PUBLIC" &&
    value !== "INTERNAL" &&
    value !== "CONFIDENTIAL" &&
    value !== "RESTRICTED"
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The export redaction profile is invalid.",
    );
  }
  return value;
}

function normalizeExpiry(value: Date | string): Date {
  const expiresAt = value instanceof Date ? new Date(value) : new Date(value);
  const now = Date.now();
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= now ||
    expiresAt.getTime() > now + MAX_APPROVAL_LIFETIME_MS
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The export approval expiry is invalid.",
    );
  }
  return expiresAt;
}

function projection(row: ExportApprovalRow): ExportApprovalProjection {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    caseId: row.caseId,
    purpose: row.purpose,
    previewHash: row.previewHash,
    redactionProfile: normalizeProfile(row.redactionProfile),
    requestedByPrincipalId: row.requestedByPrincipalId,
    reviewedByPrincipalId: row.reviewedByPrincipalId,
    state: row.state as ExportApprovalProjection["state"],
    requestReason: row.requestReason,
    decisionReason: row.decisionReason,
    expiresAt: row.expiresAt,
    reviewedAt: row.reviewedAt,
    requestAuditReference: row.requestAuditReference,
    reviewAuditReference: row.reviewAuditReference,
    version: row.version,
    createdAt: row.createdAt,
  });
}

function idempotency(
  context: ResearchServiceContext,
  input: {
    idempotencyKey: IdempotencyKey;
    operation: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
) {
  if (input.idempotencyKey === internalIdempotencyKey) return null;
  if (!context.idempotencyHmacKey)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Export approval idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.idempotencyKey,
    operation: input.operation,
    requestMaterial: input.requestMaterial,
    secret: context.idempotencyHmacKey,
  });
}

function approvalId(reference: ResearchResponseReference): string {
  const id = reference.exportApprovalId;
  if (typeof id !== "string")
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored export approval result is invalid.",
    );
  return id;
}

async function loadApproval(
  context: ResearchServiceContext,
  id: string,
): Promise<ExportApprovalRow> {
  const [row] = await context.database
    .select()
    .from(exportApprovals)
    .where(
      and(
        eq(exportApprovals.workspaceId, context.workspaceId),
        eq(exportApprovals.id, id),
      ),
    )
    .limit(1);
  if (!row)
    throw createGraphQLError("NOT_FOUND", publicErrorMessage("NOT_FOUND"));
  return row;
}

async function replay(
  context: ResearchServiceContext,
  id: string,
): Promise<ExportApprovalProjection> {
  const row = await loadApproval(context, id);
  return projection(row);
}

async function isCurrentReviewer(
  context: ResearchServiceContext,
  row: ExportApprovalRow,
): Promise<boolean> {
  if (
    context.actor.type !== "user" ||
    row.requestedByPrincipalId === context.actor.principalId
  )
    return false;
  if (
    context.permissions.has("workspace:update") &&
    (context.actor.role === "owner" || context.actor.role === "admin")
  )
    return true;
  if (!row.caseId) return false;
  const membership = await createCasesRepository(context.database).get(
    context.workspaceId,
    row.caseId,
    context.actor.principalId,
  );
  return !(
    membership?.case.state !== "active" ||
    (membership.role !== "owner" && membership.role !== "reviewer")
  );
}

async function requireCurrentReviewer(
  context: ResearchServiceContext,
  row: ExportApprovalRow,
): Promise<void> {
  if (!(await isCurrentReviewer(context, row))) return forbidden();
}

async function replayReview(
  context: ResearchServiceContext,
  id: string,
): Promise<ExportApprovalProjection> {
  const row = await loadApproval(context, id);
  await requireCurrentReviewer(context, row);
  return projection(row);
}

function exactBinding(row: ExportApprovalRow, input: Binding): boolean {
  return (
    row.workspaceId === input.workspaceId &&
    row.requestedByPrincipalId === input.actorPrincipalId &&
    row.purpose === input.purpose &&
    row.caseId === (input.caseId ?? null) &&
    row.redactionProfile === input.redactionProfile &&
    row.previewHash === input.previewHash
  );
}

export function createExportApprovalService(context: ResearchServiceContext) {
  return {
    async listPending(input: {
      caseId?: string | null;
      first?: number;
    }): Promise<readonly ExportApprovalProjection[]> {
      if (
        context.actor.type !== "user" ||
        !context.permissions.has("workspace:read")
      )
        return forbidden();
      const first = input.first ?? 25;
      if (!Number.isSafeInteger(first) || first < 1 || first > 50)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The pending approval page size is invalid.",
        );
      const caseId = input.caseId ?? null;
      const workspaceReviewer =
        context.permissions.has("workspace:update") &&
        (context.actor.role === "owner" || context.actor.role === "admin");
      const caseReviewerScope = sql`EXISTS (SELECT 1 FROM ${caseMembers} INNER JOIN ${cases} ON ${cases.workspaceId} = ${caseMembers.workspaceId} AND ${cases.id} = ${caseMembers.caseId} WHERE ${caseMembers.workspaceId} = ${exportApprovals.workspaceId} AND ${caseMembers.caseId} = ${exportApprovals.caseId} AND ${caseMembers.principalId} = ${context.actor.principalId}::uuid AND ${caseMembers.deletedAt} IS NULL AND ${cases.deletedAt} IS NULL AND ${cases.state} = 'active' AND ${caseMembers.role} IN ('owner', 'reviewer'))`;
      const rows = await context.database
        .select()
        .from(exportApprovals)
        .where(
          and(
            eq(exportApprovals.workspaceId, context.workspaceId),
            ne(
              exportApprovals.requestedByPrincipalId,
              context.actor.principalId,
            ),
            eq(exportApprovals.state, "requested"),
            gt(exportApprovals.expiresAt, new Date()),
            caseId ? eq(exportApprovals.caseId, caseId) : undefined,
            workspaceReviewer ? undefined : caseReviewerScope,
          ),
        )
        .orderBy(desc(exportApprovals.createdAt), desc(exportApprovals.id))
        .limit(first);
      const authorized: ExportApprovalProjection[] = [];
      for (const row of rows) {
        if (await isCurrentReviewer(context, row))
          authorized.push(projection(row));
      }
      return authorized;
    },

    async request(input: {
      purpose: string;
      caseId?: string | null;
      previewHash: string;
      redactionProfile: ExportRedactionProfile;
      requestReason: string;
      expiresAt: Date | string;
      idempotencyKey: IdempotencyKey;
    }): Promise<ExportApprovalProjection> {
      if (
        context.actor.type !== "user" ||
        !context.permissions.has("workspace:update") ||
        !context.permissions.has("file:create") ||
        !context.permissions.has("search:read")
      ) {
        return forbidden();
      }
      const purpose = normalizeText(input.purpose, "The export purpose", 200);
      const requestReason = normalizeText(
        input.requestReason,
        "The export approval reason",
        1_000,
      );
      const previewHash = normalizeHash(input.previewHash);
      const redactionProfile = normalizeProfile(input.redactionProfile);
      const expiresAt = normalizeExpiry(input.expiresAt);
      const caseId = input.caseId ?? null;
      if (caseId) await createCasesService(context).getCase(caseId);
      const claim = idempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "export.approval.request",
        requestMaterial: {
          caseId,
          expiresAt: expiresAt.toISOString(),
          previewHash,
          purpose,
          redactionProfile,
          requestReason,
        },
      });
      if (claim) {
        const result = await runPrincipalIdempotentResearchWrite(
          context,
          claim,
          ["workspace:update", "file:create", "search:read"],
          async (scoped) => ({
            exportApprovalId: (
              await createExportApprovalService(scoped).request({
                ...input,
                caseId,
                expiresAt,
                previewHash,
                purpose,
                redactionProfile,
                requestReason,
                idempotencyKey: internalIdempotencyKey,
              })
            ).id,
          }),
        );
        return replay(context, approvalId(result.responseReference));
      }

      return context.database.transaction(async (database) => {
        const id = newId();
        const requestAuditReference = await createAuditService(context).write(
          database,
          {
            action: "export.approval.requested",
            resourceKind: "export_approval",
            resourceId: id,
            changedFields: [
              "caseId",
              "purpose",
              "previewHash",
              "redactionProfile",
              "expiresAt",
            ],
          },
        );
        const [created] = await database
          .insert(exportApprovals)
          .values({
            id,
            workspaceId: context.workspaceId,
            caseId,
            purpose,
            previewHash,
            redactionProfile,
            requestedByPrincipalId: context.actor.principalId,
            requestReason,
            expiresAt,
            requestAuditReference,
            createdBy: context.actor.principalId,
            updatedBy: context.actor.principalId,
          })
          .returning();
        if (!created) throw new Error("Export approval insert failed");
        return projection(created);
      });
    },

    async review(input: {
      id: string;
      expectedVersion: number;
      expectedPreviewHash: string;
      decision: "approved" | "rejected";
      reason: string;
      idempotencyKey: IdempotencyKey;
    }): Promise<ExportApprovalProjection> {
      if (context.actor.type !== "user") return forbidden();
      const actor = context.actor;
      const reason = normalizeText(
        input.reason,
        "The export review reason",
        1_000,
      );
      const expectedPreviewHash = normalizeHash(input.expectedPreviewHash);
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        (input.decision !== "approved" && input.decision !== "rejected")
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The export review decision is invalid.",
        );
      }
      const claim = idempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "export.approval.review",
        requestMaterial: {
          decision: input.decision,
          expectedVersion: input.expectedVersion,
          expectedPreviewHash,
          id: input.id,
          reason,
        },
      });
      if (claim) {
        const result = await runPrincipalIdempotentResearchWrite(
          context,
          claim,
          ["workspace:read"],
          async (scoped) => ({
            exportApprovalId: (
              await createExportApprovalService(scoped).review({
                ...input,
                expectedPreviewHash,
                reason,
                idempotencyKey: internalIdempotencyKey,
              })
            ).id,
          }),
        );
        return replayReview(context, approvalId(result.responseReference));
      }

      return context.database.transaction(async (database) => {
        const scoped = { ...context, database };
        const current = await loadApproval(scoped, input.id);
        await requireCurrentReviewer(scoped, current);
        if (
          current.previewHash !== expectedPreviewHash ||
          current.state !== "requested" ||
          current.version !== input.expectedVersion ||
          current.expiresAt.getTime() <= Date.now()
        )
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));

        const reviewedAt = new Date();
        if (current.expiresAt.getTime() <= reviewedAt.getTime())
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        const reviewAuditReference = await createAuditService(context).write(
          database,
          {
            action: "export.approval.reviewed",
            resourceKind: "export_approval",
            resourceId: current.id,
            changedFields: ["state", "decisionReason", "reviewedAt"],
            metadata: { decision: input.decision },
          },
        );
        const [reviewed] = await database
          .update(exportApprovals)
          .set({
            state: input.decision,
            decisionReason: reason,
            reviewAuditReference,
            reviewedAt,
            reviewedByPrincipalId: actor.principalId,
            updatedAt: reviewedAt,
            updatedBy: actor.principalId,
            version: sql`${exportApprovals.version} + 1`,
          })
          .where(
            and(
              eq(exportApprovals.workspaceId, context.workspaceId),
              eq(exportApprovals.id, input.id),
              eq(
                exportApprovals.requestedByPrincipalId,
                current.requestedByPrincipalId,
              ),
              eq(exportApprovals.state, "requested"),
              eq(exportApprovals.version, input.expectedVersion),
            ),
          )
          .returning();
        if (!reviewed)
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        return projection(reviewed);
      });
    },

    async requireApproved(
      input: Binding & { now: Date },
    ): Promise<ExportApprovalProjection> {
      if (
        context.actor.type !== "user" ||
        input.workspaceId !== context.workspaceId ||
        input.actorPrincipalId !== context.actor.principalId ||
        !Number.isFinite(input.now?.getTime?.())
      ) {
        return precondition();
      }
      let purpose: string;
      let previewHash: string;
      let redactionProfile: ExportRedactionProfile;
      try {
        purpose = normalizeText(input.purpose, "The export purpose", 200);
        previewHash = normalizeHash(input.previewHash);
        redactionProfile = normalizeProfile(input.redactionProfile);
      } catch {
        return precondition();
      }
      const caseId = input.caseId ?? null;
      const [row] = await context.database
        .select()
        .from(exportApprovals)
        .where(
          and(
            eq(exportApprovals.workspaceId, context.workspaceId),
            eq(
              exportApprovals.requestedByPrincipalId,
              context.actor.principalId,
            ),
            eq(exportApprovals.purpose, purpose),
            caseId === null
              ? isNull(exportApprovals.caseId)
              : eq(exportApprovals.caseId, caseId),
            eq(exportApprovals.previewHash, previewHash),
            eq(exportApprovals.redactionProfile, redactionProfile),
            eq(exportApprovals.state, "approved"),
            gt(exportApprovals.expiresAt, input.now),
          ),
        )
        .limit(1);
      if (
        !row ||
        row.state !== "approved" ||
        row.expiresAt.getTime() <= input.now.getTime() ||
        !exactBinding(row, {
          workspaceId: input.workspaceId,
          actorPrincipalId: input.actorPrincipalId,
          purpose,
          caseId,
          redactionProfile,
          previewHash,
        })
      ) {
        return precondition();
      }
      return projection(row);
    },
  };
}

export type ExportApprovalService = ReturnType<
  typeof createExportApprovalService
>;
