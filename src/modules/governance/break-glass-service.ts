import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  breakGlassAccessRequests,
  breakGlassAccessResources,
} from "@/db/schema/governance";
import { createGraphQLError } from "@/graphql/errors";
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
import { normalizePagination } from "@/graphql/limits";

import {
  normalizeBreakGlassRequest,
  normalizeBreakGlassResources,
  type BreakGlassResourceKind,
} from "./break-glass-validation";

type RequestRow = typeof breakGlassAccessRequests.$inferSelect;
type ResourceRow = typeof breakGlassAccessResources.$inferSelect;
type RequestWithResources = RequestRow & { resources: ResourceRow[] };
const internalKey = Symbol("break-glass-idempotency");
type IdempotencyKey = string | typeof internalKey;
const ttl = 24 * 60 * 60 * 1_000;

function permission(context: ResearchServiceContext, key: string): void {
  if (!context.permissions.has(key)) {
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
  }
}

function userOnly(context: ResearchServiceContext): void {
  if (context.actor.type !== "user") {
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
  }
}

function reviewerOnly(context: ResearchServiceContext): void {
  userOnly(context);
  if (context.actor.role !== "owner" && context.actor.role !== "admin") {
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
  }
}

function idempotency(
  context: ResearchServiceContext,
  input: {
    idempotencyKey: IdempotencyKey;
    operation: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
) {
  if (input.idempotencyKey === internalKey) return null;
  if (!context.idempotencyHmacKey) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Break-glass idempotency is not configured.",
    );
  }
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + ttl),
    idempotencyKey: input.idempotencyKey,
    operation: input.operation,
    requestMaterial: input.requestMaterial,
    secret: context.idempotencyHmacKey,
  });
}

function referenceId(reference: ResearchResponseReference): string {
  const id = reference.breakGlassRequestId;
  if (typeof id !== "string") {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored break-glass result is invalid.",
    );
  }
  return id;
}

function cursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}

function parseCursor(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { t?: unknown; i?: unknown };
    const createdAt = new Date(typeof parsed.t === "string" ? parsed.t : "");
    return typeof parsed.i === "string" && !Number.isNaN(createdAt.getTime())
      ? { createdAt, id: parsed.i }
      : null;
  } catch {
    return null;
  }
}

async function loadRequest(
  context: ResearchServiceContext,
  id: string,
): Promise<RequestWithResources> {
  const [request] = await context.database
    .select()
    .from(breakGlassAccessRequests)
    .where(
      and(
        eq(breakGlassAccessRequests.workspaceId, context.workspaceId),
        eq(breakGlassAccessRequests.id, id),
        isNull(breakGlassAccessRequests.deletedAt),
      ),
    )
    .limit(1);
  if (!request) {
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested break-glass record was not found.",
    );
  }
  const resources = await context.database
    .select()
    .from(breakGlassAccessResources)
    .where(
      and(
        eq(breakGlassAccessResources.workspaceId, context.workspaceId),
        eq(breakGlassAccessResources.requestId, request.id),
      ),
    );
  return { ...request, resources };
}

export function breakGlassResourceVisibilitySql(
  context: Pick<ResearchServiceContext, "actor" | "workspaceId">,
  input: { resourceKind: unknown; resourceId: unknown },
) {
  return sql`EXISTS (
    SELECT 1
    FROM ${breakGlassAccessResources} AS "break_glass_resource"
    INNER JOIN ${breakGlassAccessRequests} AS "break_glass_request"
      ON "break_glass_request"."workspace_id" = "break_glass_resource"."workspace_id"
     AND "break_glass_request"."id" = "break_glass_resource"."request_id"
    WHERE "break_glass_resource"."workspace_id" = ${context.workspaceId}::uuid
      AND "break_glass_resource"."resource_kind" = ${input.resourceKind}
      AND "break_glass_resource"."resource_id" = ${input.resourceId}
      AND "break_glass_request"."requester_principal_id" = ${context.actor.principalId}::uuid
      AND "break_glass_request"."state" = 'approved'
      AND "break_glass_request"."expires_at" > ${new Date().toISOString()}::timestamptz
      AND "break_glass_request"."deleted_at" IS NULL
  )`;
}

export function createBreakGlassService(context: ResearchServiceContext) {
  const audit = createAuditService(context);
  const actor = context.actor.principalId;

  async function requestDirect(
    normalized: ReturnType<typeof normalizeBreakGlassRequest>,
    resources: ReturnType<typeof normalizeBreakGlassResources>,
  ): Promise<RequestWithResources> {
    const [created] = await context.database.transaction(async (tx) => {
      const [row] = await tx
        .insert(breakGlassAccessRequests)
        .values({
          id: newId(),
          workspaceId: context.workspaceId,
          requesterPrincipalId: actor,
          purpose: normalized.purpose,
          justification: normalized.justification,
          caseReference: normalized.caseReference,
          expiresAt: normalized.expiresAt,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning();
      if (!row) throw new Error("Break-glass request insert failed");
      await tx.insert(breakGlassAccessResources).values(
        resources.map((resource) => ({
          id: newId(),
          workspaceId: context.workspaceId,
          requestId: row.id,
          resourceKind: resource.resourceKind,
          resourceId: resource.resourceId,
          createdBy: actor,
        })),
      );
      await audit.write(tx, {
        action: "governance.break_glass.request",
        changedFields: ["purpose", "justification", "expiresAt", "resources"],
        resourceKind: "break_glass_access_request",
        resourceId: row.id,
      });
      return [row];
    });
    return loadRequest(context, created!.id);
  }

  async function reviewDirect(input: {
    id: string;
    expectedVersion: number;
    state: "approved" | "rejected";
    reason: string;
  }): Promise<RequestWithResources> {
    const [updated] = await context.database.transaction(async (tx) => {
      const [row] = await tx
        .update(breakGlassAccessRequests)
        .set({
          state: input.state,
          reviewerPrincipalId: actor,
          reviewedAt: new Date(),
          reviewReason: input.reason,
          updatedAt: new Date(),
          updatedBy: actor,
          version: sql`${breakGlassAccessRequests.version} + 1`,
        })
        .where(
          and(
            eq(breakGlassAccessRequests.workspaceId, context.workspaceId),
            eq(breakGlassAccessRequests.id, input.id),
            eq(breakGlassAccessRequests.version, input.expectedVersion),
            eq(breakGlassAccessRequests.state, "requested"),
            gt(breakGlassAccessRequests.expiresAt, new Date()),
            isNull(breakGlassAccessRequests.deletedAt),
            sql`${breakGlassAccessRequests.requesterPrincipalId} <> ${actor}::uuid`,
          ),
        )
        .returning();
      if (!row) {
        throw createGraphQLError(
          "CONFLICT",
          "The break-glass request could not be reviewed.",
        );
      }
      await audit.write(tx, {
        action: "governance.break_glass.review",
        changedFields: ["state", "reviewReason", "reviewerPrincipalId"],
        resourceKind: "break_glass_access_request",
        resourceId: row.id,
      });
      return [row];
    });
    return loadRequest(context, updated!.id);
  }

  return {
    async request(input: {
      purpose: unknown;
      justification: unknown;
      expiresAt: unknown;
      caseReference?: unknown;
      resources: unknown;
      idempotencyKey: IdempotencyKey;
    }): Promise<RequestWithResources> {
      permission(context, "breakGlass:create");
      userOnly(context);
      const normalized = normalizeBreakGlassRequest(input);
      const resources = normalizeBreakGlassResources(input.resources);
      const idem = idempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.break_glass.request",
        requestMaterial: {
          caseReference: normalized.caseReference,
          expiresAt: normalized.expiresAt.toISOString(),
          justification: normalized.justification,
          purpose: normalized.purpose,
          resources: resources.map((resource) => ({
            resourceId: resource.resourceId,
            resourceKind: resource.resourceKind,
          })),
        },
      });
      if (idem) {
        const result = await runPrincipalIdempotentResearchWrite(
          context,
          idem,
          ["breakGlass:create"],
          async (scoped) => ({
            breakGlassRequestId: (
              await createBreakGlassService(scoped).request({
                ...input,
                idempotencyKey: internalKey,
              })
            ).id,
          }),
        );
        return loadRequest(context, referenceId(result.responseReference));
      }
      return requestDirect(normalized, resources);
    },

    async review(input: {
      id: string;
      expectedVersion: number;
      state: "approved" | "rejected";
      reason: unknown;
      idempotencyKey: IdempotencyKey;
    }): Promise<RequestWithResources> {
      permission(context, "breakGlass:update");
      reviewerOnly(context);
      const reason = normalizeBreakGlassRequest({
        purpose: "review",
        justification: input.reason,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }).justification;
      const idem = idempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.break_glass.review",
        requestMaterial: {
          expectedVersion: input.expectedVersion,
          id: input.id,
          reason,
          state: input.state,
        },
      });
      if (idem) {
        const result = await runPrincipalIdempotentResearchWrite(
          context,
          idem,
          ["breakGlass:update"],
          async (scoped) => ({
            breakGlassRequestId: (
              await createBreakGlassService(scoped).review({
                ...input,
                idempotencyKey: internalKey,
                reason,
              })
            ).id,
          }),
        );
        return loadRequest(context, referenceId(result.responseReference));
      }
      return reviewDirect({ ...input, reason });
    },

    async revoke(input: {
      id: string;
      expectedVersion: number;
      reason: unknown;
      idempotencyKey: IdempotencyKey;
    }): Promise<RequestWithResources> {
      permission(context, "breakGlass:update");
      reviewerOnly(context);
      const reason = normalizeBreakGlassRequest({
        purpose: "revocation",
        justification: input.reason,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }).justification;
      const idem = idempotency(context, {
        idempotencyKey: input.idempotencyKey,
        operation: "governance.break_glass.revoke",
        requestMaterial: {
          expectedVersion: input.expectedVersion,
          id: input.id,
          reason,
        },
      });
      if (idem) {
        const result = await runPrincipalIdempotentResearchWrite(
          context,
          idem,
          ["breakGlass:update"],
          async (scoped) => ({
            breakGlassRequestId: (
              await createBreakGlassService(scoped).revoke({
                ...input,
                idempotencyKey: internalKey,
                reason,
              })
            ).id,
          }),
        );
        return loadRequest(context, referenceId(result.responseReference));
      }
      const [updated] = await context.database.transaction(async (tx) => {
        const [row] = await tx
          .update(breakGlassAccessRequests)
          .set({
            state: "revoked",
            revokedAt: new Date(),
            revokedBy: actor,
            revokeReason: reason,
            updatedAt: new Date(),
            updatedBy: actor,
            version: sql`${breakGlassAccessRequests.version} + 1`,
          })
          .where(
            and(
              eq(breakGlassAccessRequests.workspaceId, context.workspaceId),
              eq(breakGlassAccessRequests.id, input.id),
              eq(breakGlassAccessRequests.version, input.expectedVersion),
              eq(breakGlassAccessRequests.state, "approved"),
              isNull(breakGlassAccessRequests.deletedAt),
            ),
          )
          .returning();
        if (!row) {
          throw createGraphQLError(
            "CONFLICT",
            "The break-glass request could not be revoked.",
          );
        }
        await audit.write(tx, {
          action: "governance.break_glass.revoke",
          changedFields: ["state", "revokeReason"],
          resourceKind: "break_glass_access_request",
          resourceId: row.id,
        });
        return [row];
      });
      return loadRequest(context, updated!.id);
    },

    async list(input: { first?: number | null; after?: string | null } = {}) {
      permission(context, "breakGlass:read");
      userOnly(context);
      const page = normalizePagination(input);
      const after = parseCursor(page.after);
      if (page.after && !after) {
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      }
      const rows = await context.database
        .select()
        .from(breakGlassAccessRequests)
        .where(
          and(
            eq(breakGlassAccessRequests.workspaceId, context.workspaceId),
            isNull(breakGlassAccessRequests.deletedAt),
            context.actor.role === "owner" || context.actor.role === "admin"
              ? undefined
              : eq(
                  breakGlassAccessRequests.requesterPrincipalId,
                  context.actor.principalId,
                ),
            after
              ? or(
                  lt(breakGlassAccessRequests.createdAt, after.createdAt),
                  and(
                    eq(breakGlassAccessRequests.createdAt, after.createdAt),
                    lt(breakGlassAccessRequests.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(breakGlassAccessRequests.createdAt),
          desc(breakGlassAccessRequests.id),
        )
        .limit(page.first + 1);
      const nodes = await Promise.all(
        rows.slice(0, page.first).map((row) => loadRequest(context, row.id)),
      );
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: nodes.at(-1) ? cursor(nodes.at(-1)!) : null,
        },
      };
    },

    async get(id: string): Promise<RequestWithResources> {
      const row = await loadRequest(context, id);
      if (
        context.actor.role !== "owner" &&
        context.actor.role !== "admin" &&
        row.requesterPrincipalId !== context.actor.principalId
      ) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested break-glass record was not found.",
        );
      }
      return row;
    },
  };
}

export type BreakGlassService = ReturnType<typeof createBreakGlassService>;
