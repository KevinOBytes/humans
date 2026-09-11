import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import {
  consentRecords,
  deletionRequests,
  privacyRequests,
  privacyProcessorPropagations,
} from "@/db/schema/privacy";
import { createGraphQLError } from "@/graphql/errors";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { runResearchTransaction } from "@/modules/audit/transactions";
import { createCasesService } from "@/modules/cases/service";
import {
  normalizePrivacyRequest,
  assertPrivacyTransition,
} from "./request-validation";
import {
  privacyProcessors,
  type PrivacyRequestRow,
  type PrivacyRequestState,
} from "./request-types";
import {
  hasLegalHold,
  privacyPermission,
  privacyPolicyLock,
  requirePrivacyResource,
} from "./retention-service";

function unavailable(): never {
  throw createGraphQLError(
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}
function precondition(): never {
  throw createGraphQLError(
    "PRECONDITION_FAILED",
    "The privacy request cannot be fulfilled yet.",
  );
}
async function requireScope(
  context: ResearchServiceContext,
  row: Pick<PrivacyRequestRow, "caseId" | "scope">,
  includeDeleted = false,
) {
  if (row.caseId) await createCasesService(context).getCase(row.caseId);
  for (const id of row.scope.personIds)
    await requirePrivacyResource(
      context,
      { resourceKind: "person", resourceId: id },
      includeDeleted,
    );
  for (const id of row.scope.fileIds)
    await requirePrivacyResource(
      context,
      { resourceKind: "file", resourceId: id },
      includeDeleted,
    );
}
async function evidence(context: ResearchServiceContext, id: string) {
  await requirePrivacyResource(context, {
    resourceKind: "file",
    resourceId: id,
  });
  const [row] = await context.database
    .select({ state: files.quarantineState, scan: files.scanState })
    .from(files)
    .where(and(eq(files.workspaceId, context.workspaceId), eq(files.id, id)))
    .limit(1);
  if (
    !row ||
    row.state !== "available" ||
    !["clean", "not_required"].includes(row.scan)
  )
    precondition();
}
export async function privacyRequestHeld(
  context: Pick<ResearchServiceContext, "database" | "workspaceId">,
  row: Pick<PrivacyRequestRow, "scope">,
) {
  for (const resourceId of row.scope.personIds)
    if (await hasLegalHold(context, { resourceKind: "person", resourceId }))
      return true;
  for (const resourceId of row.scope.fileIds)
    if (await hasLegalHold(context, { resourceKind: "file", resourceId }))
      return true;
  return false;
}
export function createPrivacyRequestService(context: ResearchServiceContext) {
  async function read(
    scoped: ResearchServiceContext,
    id: string,
    lock = false,
  ) {
    privacyPermission(scoped);
    const query = scoped.database
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.workspaceId, scoped.workspaceId),
          eq(privacyRequests.id, id),
          isNull(privacyRequests.deletedAt),
        ),
      )
      .limit(1);
    const [row] = lock ? await query.for("update") : await query;
    if (!row) unavailable();
    if (
      row.requesterId !== scoped.actor.principalId &&
      !scoped.permissions.has("workspace:update")
    )
      unavailable();
    await requireScope(scoped, row, true);
    return row;
  }
  async function update(
    scoped: ResearchServiceContext,
    row: PrivacyRequestRow,
    values: Partial<typeof privacyRequests.$inferInsert>,
    action: string,
  ) {
    const auditReference = await createAuditService(scoped).write(
      scoped.database,
      {
        action,
        resourceKind: "privacy_request",
        resourceId: row.id,
        changedFields: Object.keys(values),
        metadata: { state: values.state ?? row.state },
      },
    );
    const [updated] = await scoped.database
      .update(privacyRequests)
      .set({
        ...values,
        auditReference,
        version: row.version + 1,
        updatedAt: new Date(),
        updatedBy: scoped.actor.principalId,
      })
      .where(
        and(
          eq(privacyRequests.workspaceId, scoped.workspaceId),
          eq(privacyRequests.id, row.id),
          eq(privacyRequests.version, row.version),
        ),
      )
      .returning();
    if (!updated)
      throw createGraphQLError("CONFLICT", "The request version is stale.");
    return updated;
  }
  function mutation<T>(run: (scoped: ResearchServiceContext) => Promise<T>) {
    privacyPermission(context, true);
    return runResearchTransaction(
      context,
      { requiredPermissions: ["workspace:update"] },
      async (scoped) => {
        await privacyPolicyLock(scoped);
        return run(scoped);
      },
    );
  }
  return {
    getRequest: (id: string) => read(context, id),
    async createRequest(input: unknown) {
      return mutation(async (scoped) => {
        const key = z
          .object({ idempotencyKey: z.string().trim().min(1).max(128) })
          .parse(input).idempotencyKey;
        if (
          !scoped.idempotencyHmacKey ||
          !/^[a-f0-9]{64}$/iu.test(scoped.idempotencyHmacKey)
        )
          precondition();
        const hash = (material: string) =>
          createHmac("sha256", Buffer.from(scoped.idempotencyHmacKey!, "hex"))
            .update(material)
            .digest("hex");
        const idempotencyHash = hash(
          `privacy:key:${scoped.workspaceId}:${scoped.actor.principalId}:${key}`,
        );
        const [existing] = await scoped.database
          .select()
          .from(privacyRequests)
          .where(
            and(
              eq(privacyRequests.workspaceId, scoped.workspaceId),
              eq(privacyRequests.requesterId, scoped.actor.principalId),
              eq(privacyRequests.idempotencyHash, idempotencyHash),
            ),
          )
          .limit(1);
        const normalized = normalizePrivacyRequest(
          input,
          existing ? new Date(existing.createdAt.getTime() - 1) : new Date(),
        );
        const { personIds, fileIds } = normalized;
        const fields = {
          requestType: normalized.requestType,
          caseId: normalized.caseId,
          purpose: normalized.purpose,
          dueAt: normalized.dueAt,
          executeAfter: normalized.executeAfter,
        };
        const scope = { personIds, fileIds };
        const requestHash = hash(
          JSON.stringify({
            ...fields,
            executeAfter: (input as { executeAfter?: unknown }).executeAfter
              ? fields.executeAfter.toISOString()
              : null,
            scope,
          }),
        );
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw createGraphQLError(
              "CONFLICT",
              "The idempotency key is bound to another request.",
            );
          return read(scoped, existing.id);
        }
        await requireScope(scoped, { scope, caseId: fields.caseId });
        const [created] = await scoped.database
          .insert(privacyRequests)
          .values({
            id: newId(),
            workspaceId: scoped.workspaceId,
            ...fields,
            scope,
            requesterId: scoped.actor.principalId,
            requestHash,
            idempotencyHash,
            createdBy: scoped.actor.principalId,
            updatedBy: scoped.actor.principalId,
          })
          .returning();
        if (!created) throw new Error("Privacy request insert failed");
        const auditReference = await createAuditService(scoped).write(
          scoped.database,
          {
            action: "privacy.request.created",
            resourceKind: "privacy_request",
            resourceId: created.id,
            changedFields: ["state", "requestType", "scope", "dueAt"],
          },
        );
        await scoped.database
          .update(privacyRequests)
          .set({ auditReference })
          .where(eq(privacyRequests.id, created.id));
        return { ...created, auditReference };
      });
    },
    async reviewRequest(input: {
      id: string;
      expectedVersion: number;
      state: "reviewing" | "approved" | "rejected";
      verificationEvidenceId?: string | null;
    }) {
      return mutation(async (scoped) => {
        const row = await read(scoped, input.id, true);
        if (row.version !== input.expectedVersion)
          throw createGraphQLError("CONFLICT", "The request version is stale.");
        const verified = Boolean(
          input.verificationEvidenceId || row.verificationEvidenceId,
        );
        if (input.verificationEvidenceId)
          await evidence(scoped, input.verificationEvidenceId);
        assertPrivacyTransition({
          from: row.state,
          to: input.state,
          verified,
          independentReviewer:
            row.requesterId !== scoped.actor.principalId &&
            row.requesterId !== scoped.actor.id,
        });
        return update(
          scoped,
          row,
          {
            state: input.state,
            reviewedAt: new Date(),
            reviewedBy: scoped.actor.principalId,
            ...(input.verificationEvidenceId
              ? {
                  verificationEvidenceId: input.verificationEvidenceId,
                  verifiedAt: new Date(),
                  verifiedBy: scoped.actor.principalId,
                }
              : {}),
          },
          "privacy.request.reviewed",
        );
      });
    },
    async fulfillRequest(input: {
      id: string;
      expectedVersion: number;
      completionEvidenceId?: string | null;
    }) {
      return mutation(async (scoped) => {
        const row = await read(scoped, input.id, true);
        if (row.version !== input.expectedVersion)
          throw createGraphQLError("CONFLICT", "The request version is stale.");
        const now = new Date();
        if (
          row.executeAfter > now ||
          !row.reviewedBy ||
          !row.verifiedAt ||
          !row.verificationEvidenceId
        )
          precondition();
        await evidence(scoped, row.verificationEvidenceId);
        if (
          row.requestType === "deletion" &&
          (await privacyRequestHeld(scoped, row))
        )
          precondition();
        if (row.state === "fulfilling") {
          if (!input.completionEvidenceId) precondition();
          await evidence(scoped, input.completionEvidenceId);
          if (row.legacyDeletionRequestId) {
            const [legacy] = await scoped.database
              .select({ state: deletionRequests.state })
              .from(deletionRequests)
              .where(
                and(
                  eq(deletionRequests.workspaceId, scoped.workspaceId),
                  eq(deletionRequests.id, row.legacyDeletionRequestId),
                ),
              )
              .limit(1);
            if (legacy?.state !== "completed") precondition();
          }
          const propagations = await scoped.database
            .select()
            .from(privacyProcessorPropagations)
            .where(
              and(
                eq(
                  privacyProcessorPropagations.workspaceId,
                  scoped.workspaceId,
                ),
                eq(privacyProcessorPropagations.privacyRequestId, row.id),
              ),
            );
          if (
            propagations.some(
              (r) => !["succeeded", "not_applicable"].includes(r.state),
            )
          )
            precondition();
          assertPrivacyTransition({
            from: row.state,
            to: "completed",
            verified: true,
            completionEvidence: input.completionEvidenceId,
          });
          return update(
            scoped,
            row,
            {
              state: "completed",
              completedAt: now,
              completionEvidenceId: input.completionEvidenceId,
            },
            "privacy.request.completed",
          );
        }
        assertPrivacyTransition({
          from: row.state,
          to: "fulfilling",
          verified: true,
          destructive: row.requestType === "deletion",
        });
        let legacyDeletionRequestId: string | null = null;
        if (row.requestType === "deletion") {
          // Only enqueue the established worker path; no resource is deleted here.
          legacyDeletionRequestId = newId();
          await scoped.database.insert(deletionRequests).values({
            id: legacyDeletionRequestId,
            workspaceId: scoped.workspaceId,
            requesterId: row.requesterId,
            scope: row.scope,
            state: "approved",
            reviewedAt: row.reviewedAt,
            reviewedBy: row.reviewedBy,
            createdBy: scoped.actor.principalId,
            updatedBy: scoped.actor.principalId,
          });
        }
        if (
          row.requestType === "consent_withdrawal" ||
          row.requestType === "restriction"
        ) {
          const withdrawn = await scoped.database
            .update(consentRecords)
            .set({
              status: "withdrawn",
              withdrawnAt: now,
              withdrawnBy: scoped.actor.principalId,
              withdrawalEffect:
                row.requestType === "restriction"
                  ? "restrict_processing"
                  : "stop_processing",
              updatedAt: now,
              updatedBy: scoped.actor.principalId,
              version: sql`${consentRecords.version} + 1`,
            })
            .where(
              and(
                eq(consentRecords.workspaceId, scoped.workspaceId),
                inArray(consentRecords.personId, row.scope.personIds),
                eq(consentRecords.purpose, row.purpose!),
                eq(consentRecords.status, "granted"),
                isNull(consentRecords.deletedAt),
              ),
            )
            .returning({ id: consentRecords.id });
          for (const consent of withdrawn)
            await createAuditService(scoped).write(scoped.database, {
              action: "governance.consent.withdraw",
              resourceKind: "consent_record",
              resourceId: consent.id,
              changedFields: ["status", "withdrawalEffect"],
            });
        }
        if (
          [
            "deletion",
            "consent_withdrawal",
            "restriction",
            "correction",
          ].includes(row.requestType)
        ) {
          await scoped.database.insert(privacyProcessorPropagations).values(
            privacyProcessors.map((processor) => ({
              id: newId(),
              workspaceId: scoped.workspaceId,
              privacyRequestId: row.id,
              processor,
              createdBy: scoped.actor.principalId,
              updatedBy: scoped.actor.principalId,
            })),
          );
        }
        return update(
          scoped,
          row,
          { state: "fulfilling", legacyDeletionRequestId },
          "privacy.request.fulfillment_started",
        );
      });
    },
    async cancelRequest(input: { id: string; expectedVersion: number }) {
      return mutation(async (scoped) => {
        const row = await read(scoped, input.id, true);
        if (row.version !== input.expectedVersion)
          throw createGraphQLError("CONFLICT", "The request version is stale.");
        assertPrivacyTransition({
          from: row.state,
          to: "cancelled",
          verified: Boolean(row.verifiedAt),
        });
        return update(
          scoped,
          row,
          { state: "cancelled" },
          "privacy.request.cancelled",
        );
      });
    },
    async listRequests(
      input: {
        first?: number | null;
        afterId?: string | null;
        state?: PrivacyRequestState | null;
      } = {},
    ) {
      privacyPermission(context, true);
      const first = input.first ?? 25;
      if (
        !Number.isSafeInteger(first) ||
        first < 1 ||
        first > 100 ||
        (input.afterId && !z.uuid().safeParse(input.afterId).success)
      )
        throw createGraphQLError("VALIDATION_FAILED", "Invalid page.");
      const rows = await context.database
        .select()
        .from(privacyRequests)
        .where(
          and(
            eq(privacyRequests.workspaceId, context.workspaceId),
            isNull(privacyRequests.deletedAt),
            input.afterId
              ? sql`${privacyRequests.id} > ${input.afterId}::uuid`
              : undefined,
            input.state ? eq(privacyRequests.state, input.state) : undefined,
          ),
        )
        .orderBy(asc(privacyRequests.id))
        .limit(first);
      const visible = [];
      for (const row of rows) {
        try {
          await requireScope(context, row, true);
          visible.push(row);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("extensions" in error) ||
            !["NOT_FOUND", "FORBIDDEN"].includes(
              (error.extensions as { code: string }).code,
            )
          )
            throw error;
        }
      }
      return {
        nodes: visible,
        endId: rows.at(-1)?.id ?? null,
        hasMore: rows.length === first,
      };
    },
    async listPropagations(id: string) {
      await read(context, id);
      return context.database
        .select()
        .from(privacyProcessorPropagations)
        .where(
          and(
            eq(privacyProcessorPropagations.workspaceId, context.workspaceId),
            eq(privacyProcessorPropagations.privacyRequestId, id),
          ),
        )
        .orderBy(asc(privacyProcessorPropagations.processor))
        .limit(5);
    },
  };
}
