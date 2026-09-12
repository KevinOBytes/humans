import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { caseMembers } from "@/db/schema/cases";
import { workspacePrincipals } from "@/db/schema/principals";
import {
  researchAssignmentEvents,
  researchAssignmentItems,
} from "@/db/schema/research-assignments";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
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
import { createCasesService } from "@/modules/cases/service";
import { createResearchAssignmentsRepository } from "./repository";

const QUEUE_KINDS = [
  "review",
  "verification",
  "consent_follow_up",
  "source_reconciliation",
  "privacy_request",
] as const;
const STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REASON = 2000;
const transitions: Record<string, readonly string[]> = {
  open: ["in_progress", "blocked", "cancelled"],
  in_progress: ["open", "blocked", "completed", "cancelled"],
  blocked: ["open", "in_progress", "cancelled"],
  completed: [],
  cancelled: [],
};

type QueueKind = (typeof QUEUE_KINDS)[number];
type Status = (typeof STATUSES)[number];
type ItemRow = typeof researchAssignmentItems.$inferSelect;

function permission(context: ResearchServiceContext, key: string) {
  if (!context.permissions.has(key))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}
function text(value: unknown, label: string, max: number, required = true) {
  const normalized =
    typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (
    (!normalized && required) ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  )
    throw createGraphQLError("VALIDATION_FAILED", `${label} is invalid.`);
  return normalized || null;
}
function kind(value: unknown): QueueKind {
  if (typeof value !== "string" || !QUEUE_KINDS.includes(value as QueueKind))
    throw createGraphQLError("VALIDATION_FAILED", "The queue kind is invalid.");
  return value as QueueKind;
}
function status(value: unknown): Status {
  if (typeof value !== "string" || !STATUSES.includes(value as Status))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The assignment status is invalid.",
    );
  return value as Status;
}
function priority(value: unknown) {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 100
  )
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Priority must be between 0 and 100.",
    );
  return value as number;
}
function date(value: unknown, label: string) {
  if (value == null) return null;
  const parsed =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(parsed.getTime()))
    throw createGraphQLError("VALIDATION_FAILED", `${label} is invalid.`);
  return parsed;
}
function reason(value: unknown, required = true) {
  return text(value, "Reason", MAX_REASON, required);
}
function cursor(row: Pick<ItemRow, "createdAt" | "id">) {
  return Buffer.from(
    JSON.stringify({ at: row.createdAt.toISOString(), id: row.id }),
    "utf8",
  ).toString("base64url");
}
function afterCursor(value: string | null | undefined) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { at?: string; id?: string };
    const at = new Date(decoded.at ?? "");
    if (
      !decoded.id ||
      Number.isNaN(at.getTime()) ||
      at.toISOString() !== decoded.at
    )
      throw new Error("invalid");
    return { at, id: decoded.id };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}
function item(row: ItemRow) {
  return row;
}
function referenceId(reference: ResearchResponseReference) {
  if (typeof reference.assignmentId !== "string")
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored assignment result is invalid.",
    );
  return reference.assignmentId;
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
      "Assignment idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.key,
    operation: input.operation,
    requestMaterial: input.material,
    secret: context.idempotencyHmacKey,
  });
}

export function createResearchAssignmentsService(
  context: ResearchServiceContext,
) {
  const repository = createResearchAssignmentsRepository(context.database);
  const audit = createAuditService(context);

  async function visibleCase(caseId: string | null | undefined) {
    if (!caseId) return null;
    return createCasesService(context).getCase(caseId);
  }
  async function validateAssignee(
    assigneePrincipalId: string | null,
    caseId: string | null,
  ) {
    if (!assigneePrincipalId) return;
    const [principal] = await context.database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(
        and(
          eq(workspacePrincipals.workspaceId, context.workspaceId),
          eq(workspacePrincipals.id, assigneePrincipalId),
        ),
      )
      .limit(1);
    if (!principal)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested assignee was not found.",
      );
    if (caseId) {
      const [member] = await context.database
        .select({ id: caseMembers.id })
        .from(caseMembers)
        .where(
          and(
            eq(caseMembers.workspaceId, context.workspaceId),
            eq(caseMembers.caseId, caseId),
            eq(caseMembers.principalId, assigneePrincipalId),
          ),
        )
        .limit(1);
      if (!member)
        throw createGraphQLError(
          "FORBIDDEN",
          "The assignee is not a member of this case.",
        );
    }
  }
  async function loadVisible(id: string, lock = false) {
    const row = await repository.get(context.workspaceId, id, lock);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested assignment was not found.",
      );
    await visibleCase(row.caseId);
    return row;
  }
  async function mutate(
    operation: string,
    key: string,
    material: Readonly<Record<string, CanonicalRequestMaterial>>,
    write: (
      scoped: ResearchServiceContext,
    ) => Promise<ResearchResponseReference>,
  ) {
    const result = await runPrincipalIdempotentResearchWrite(
      context,
      idempotency(context, { key, operation, material }),
      ["workspace:read", "workspace:update"],
      write,
    );
    return loadVisible(referenceId(result.responseReference));
  }

  return {
    async list(
      input: {
        caseId?: string | null;
        status?: string | null;
        queueKind?: string | null;
        first?: number | null;
        after?: string | null;
      } = {},
    ) {
      permission(context, "workspace:read");
      await visibleCase(input.caseId);
      const page = normalizePagination(input);
      const rows = await repository.list(context.workspaceId, {
        caseId: input.caseId,
        principalId: context.actor.principalId,
        status: input.status == null ? null : status(input.status),
        queueKind: input.queueKind == null ? null : kind(input.queueKind),
        first: page.first + 1,
        after: afterCursor(page.after),
      });
      const nodes = rows.slice(0, page.first).map(item);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: nodes.at(-1) ? cursor(nodes.at(-1)!) : null,
        },
      };
    },
    async get(id: string) {
      permission(context, "workspace:read");
      return loadVisible(id);
    },
    async events(id: string) {
      permission(context, "workspace:read");
      await loadVisible(id);
      return repository.events(context.workspaceId, id);
    },
    async create(input: {
      caseId?: string | null;
      queueKind: string;
      title: string;
      description?: string | null;
      priority?: number | null;
      assigneePrincipalId?: string | null;
      dueAt?: Date | string | null;
      idempotencyKey: string;
    }) {
      permission(context, "workspace:update");
      const caseId = input.caseId ?? null;
      await visibleCase(caseId);
      const normalized = {
        caseId,
        queueKind: kind(input.queueKind),
        title: text(input.title, "Title", 200)!,
        description: text(input.description, "Description", 4000, false),
        priority: input.priority == null ? 0 : priority(input.priority),
        assigneePrincipalId: input.assigneePrincipalId ?? null,
        dueAt: date(input.dueAt, "Due date"),
      };
      await validateAssignee(normalized.assigneePrincipalId, caseId);
      return mutate(
        "research-assignment.create",
        input.idempotencyKey,
        { ...normalized, dueAt: normalized.dueAt?.toISOString() ?? null },
        async (scoped) => {
          const [row] = await scoped.database
            .insert(researchAssignmentItems)
            .values({
              id: newId(),
              workspaceId: scoped.workspaceId,
              ...normalized,
              createdBy: scoped.actor.principalId,
              updatedBy: scoped.actor.principalId,
            })
            .returning();
          if (!row) throw new Error("Assignment insert failed");
          await scoped.database.insert(researchAssignmentEvents).values({
            id: newId(),
            workspaceId: scoped.workspaceId,
            assignmentId: row.id,
            eventKind: "created",
            toAssigneePrincipalId: row.assigneePrincipalId,
            reason: null,
            actorPrincipalId: scoped.actor.principalId,
            occurredAt: new Date(),
          });
          await audit.write(scoped.database, {
            action: "research_assignment.create",
            resourceKind: "research_assignment",
            resourceId: row.id,
            changedFields: [
              "queueKind",
              "caseId",
              "title",
              "priority",
              "assigneePrincipalId",
              "dueAt",
            ],
          });
          return { assignmentId: row.id };
        },
      );
    },
    async assign(input: {
      id: string;
      expectedVersion: number;
      assigneePrincipalId?: string | null;
      reason: string;
      idempotencyKey: string;
    }) {
      permission(context, "workspace:update");
      const normalizedReason = reason(input.reason)!;
      return mutate(
        "research-assignment.assign",
        input.idempotencyKey,
        {
          id: input.id,
          expectedVersion: input.expectedVersion,
          assigneePrincipalId: input.assigneePrincipalId ?? null,
          reason: normalizedReason,
        },
        async (scoped) => {
          const row = await createResearchAssignmentsRepository(
            scoped.database,
          ).get(scoped.workspaceId, input.id, true);
          if (!row)
            throw createGraphQLError(
              "NOT_FOUND",
              "The requested assignment was not found.",
            );
          await visibleCase(row.caseId);
          await validateAssignee(input.assigneePrincipalId ?? null, row.caseId);
          if (row.version !== input.expectedVersion)
            throw createGraphQLError("CONFLICT", "The assignment has changed.");
          if (["completed", "cancelled"].includes(row.status))
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "A closed assignment cannot be assigned.",
            );
          const [updated] = await scoped.database
            .update(researchAssignmentItems)
            .set({
              assigneePrincipalId: input.assigneePrincipalId ?? null,
              version: row.version + 1,
              updatedAt: new Date(),
              updatedBy: scoped.actor.principalId,
            })
            .where(
              and(
                eq(researchAssignmentItems.workspaceId, scoped.workspaceId),
                eq(researchAssignmentItems.id, row.id),
                eq(researchAssignmentItems.version, row.version),
              ),
            )
            .returning();
          if (!updated)
            throw createGraphQLError("CONFLICT", "The assignment has changed.");
          await scoped.database.insert(researchAssignmentEvents).values({
            id: newId(),
            workspaceId: scoped.workspaceId,
            assignmentId: row.id,
            eventKind: "assigned",
            fromAssigneePrincipalId: row.assigneePrincipalId,
            toAssigneePrincipalId: updated.assigneePrincipalId,
            reason: normalizedReason,
            actorPrincipalId: scoped.actor.principalId,
            occurredAt: new Date(),
          });
          await audit.write(scoped.database, {
            action: "research_assignment.assign",
            resourceKind: "research_assignment",
            resourceId: row.id,
            changedFields: ["assigneePrincipalId", "version"],
          });
          return { assignmentId: row.id };
        },
      );
    },
    async transition(input: {
      id: string;
      expectedVersion: number;
      status: string;
      reason: string;
      idempotencyKey: string;
    }) {
      permission(context, "workspace:update");
      const next = status(input.status);
      const normalizedReason = reason(input.reason)!;
      return mutate(
        "research-assignment.transition",
        input.idempotencyKey,
        {
          id: input.id,
          expectedVersion: input.expectedVersion,
          status: next,
          reason: normalizedReason,
        },
        async (scoped) => {
          const row = await createResearchAssignmentsRepository(
            scoped.database,
          ).get(scoped.workspaceId, input.id, true);
          if (!row)
            throw createGraphQLError(
              "NOT_FOUND",
              "The requested assignment was not found.",
            );
          await visibleCase(row.caseId);
          if (row.version !== input.expectedVersion)
            throw createGraphQLError("CONFLICT", "The assignment has changed.");
          if (!transitions[row.status]?.includes(next))
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "The assignment status transition is invalid.",
            );
          const [updated] = await scoped.database
            .update(researchAssignmentItems)
            .set({
              status: next,
              version: row.version + 1,
              updatedAt: new Date(),
              updatedBy: scoped.actor.principalId,
            })
            .where(
              and(
                eq(researchAssignmentItems.workspaceId, scoped.workspaceId),
                eq(researchAssignmentItems.id, row.id),
                eq(researchAssignmentItems.version, row.version),
              ),
            )
            .returning();
          if (!updated)
            throw createGraphQLError("CONFLICT", "The assignment has changed.");
          await scoped.database.insert(researchAssignmentEvents).values({
            id: newId(),
            workspaceId: scoped.workspaceId,
            assignmentId: row.id,
            eventKind: "status_changed",
            fromStatus: row.status,
            toStatus: next,
            reason: normalizedReason,
            actorPrincipalId: scoped.actor.principalId,
            occurredAt: new Date(),
          });
          await audit.write(scoped.database, {
            action: "research_assignment.status",
            resourceKind: "research_assignment",
            resourceId: row.id,
            changedFields: ["status", "version"],
          });
          return { assignmentId: row.id };
        },
      );
    },
    async escalate(input: {
      id: string;
      expectedVersion: number;
      reason: string;
      idempotencyKey: string;
    }) {
      permission(context, "workspace:update");
      const normalizedReason = reason(input.reason)!;
      return mutate(
        "research-assignment.escalate",
        input.idempotencyKey,
        {
          id: input.id,
          expectedVersion: input.expectedVersion,
          reason: normalizedReason,
        },
        async (scoped) => {
          const row = await createResearchAssignmentsRepository(
            scoped.database,
          ).get(scoped.workspaceId, input.id, true);
          if (!row)
            throw createGraphQLError(
              "NOT_FOUND",
              "The requested assignment was not found.",
            );
          await visibleCase(row.caseId);
          if (row.version !== input.expectedVersion)
            throw createGraphQLError("CONFLICT", "The assignment has changed.");
          if (["completed", "cancelled"].includes(row.status))
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "A closed assignment cannot be escalated.",
            );
          const [updated] = await scoped.database
            .update(researchAssignmentItems)
            .set({
              escalationCount: row.escalationCount + 1,
              version: row.version + 1,
              updatedAt: new Date(),
              updatedBy: scoped.actor.principalId,
            })
            .where(
              and(
                eq(researchAssignmentItems.workspaceId, scoped.workspaceId),
                eq(researchAssignmentItems.id, row.id),
                eq(researchAssignmentItems.version, row.version),
              ),
            )
            .returning();
          if (!updated)
            throw createGraphQLError("CONFLICT", "The assignment has changed.");
          await scoped.database.insert(researchAssignmentEvents).values({
            id: newId(),
            workspaceId: scoped.workspaceId,
            assignmentId: row.id,
            eventKind: "escalated",
            reason: normalizedReason,
            actorPrincipalId: scoped.actor.principalId,
            occurredAt: new Date(),
          });
          await audit.write(scoped.database, {
            action: "research_assignment.escalate",
            resourceKind: "research_assignment",
            resourceId: row.id,
            changedFields: ["escalationCount", "version"],
          });
          return { assignmentId: row.id };
        },
      );
    },
  };
}

export type ResearchAssignmentsService = ReturnType<
  typeof createResearchAssignmentsService
>;
