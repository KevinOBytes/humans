import { and, eq, isNull } from "drizzle-orm";

import { newId } from "@/db/id";
import { caseMembers, cases } from "@/db/schema/cases";
import { members } from "@/db/schema/auth";
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
    JSON.stringify({ v: 1, t: row.createdAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function eventCursor(row: { occurredAt: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ v: 1, t: row.occurredAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}
function afterEventCursor(value: string | null | undefined) {
  if (!value) return null;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("invalid");
    const decoded = JSON.parse(bytes.toString("utf8")) as {
      v?: number;
      t?: string;
      i?: string;
    };
    if (
      Object.keys(decoded).sort().join(",") !== "i,t,v" ||
      decoded.i !== decoded.i?.toLowerCase()
    )
      throw new Error("invalid");
    const at = new Date(decoded.t ?? "");
    if (
      decoded.v !== 1 ||
      !UUID.test(decoded.i ?? "") ||
      Number.isNaN(at.getTime()) ||
      at.toISOString() !== decoded.t
    )
      throw new Error("invalid");
    return { at, id: decoded.i! };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}
function afterCursor(value: string | null | undefined) {
  if (!value) return null;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("invalid");
    const decoded = JSON.parse(bytes.toString("utf8")) as {
      v?: number;
      t?: string;
      i?: string;
    };
    if (
      Object.keys(decoded).sort().join(",") !== "i,t,v" ||
      decoded.i !== decoded.i?.toLowerCase()
    )
      throw new Error("invalid");
    const at = new Date(decoded.t ?? "");
    if (
      decoded.v !== 1 ||
      !UUID.test(decoded.i ?? "") ||
      Number.isNaN(at.getTime()) ||
      at.toISOString() !== decoded.t
    )
      throw new Error("invalid");
    return { at, id: decoded.i! };
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

  async function visibleCase(
    scoped: ResearchServiceContext,
    caseId: string | null | undefined,
  ) {
    if (!caseId) return null;
    return createCasesService(scoped).getCase(caseId);
  }
  async function validateAssignee(
    database: ResearchServiceContext["database"],
    assigneePrincipalId: string | null,
    caseId: string | null,
  ) {
    if (!assigneePrincipalId) return;
    const [principal] = await database
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .innerJoin(
        members,
        and(
          eq(members.workspaceId, workspacePrincipals.workspaceId),
          eq(members.id, workspacePrincipals.memberIdSnapshot!),
        ),
      )
      .where(
        and(
          eq(workspacePrincipals.workspaceId, context.workspaceId),
          eq(workspacePrincipals.id, assigneePrincipalId),
          eq(workspacePrincipals.principalType, "user"),
        ),
      )
      .limit(1)
      .for("update");
    if (!principal)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested assignee was not found.",
      );
    if (caseId) {
      const [member] = await database
        .select({ id: caseMembers.id })
        .from(caseMembers)
        .where(
          and(
            eq(caseMembers.workspaceId, context.workspaceId),
            eq(caseMembers.caseId, caseId),
            eq(caseMembers.principalId, assigneePrincipalId),
            isNull(caseMembers.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!member)
        throw createGraphQLError(
          "FORBIDDEN",
          "The assignee is not a member of this case.",
        );
    }
  }
  async function authorizeMutation(
    scoped: ResearchServiceContext,
    caseId: string | null,
  ) {
    if (!caseId) {
      permission(scoped, "workspace:update");
      return;
    }
    const [authority] = await scoped.database
      .select({ role: caseMembers.role })
      .from(caseMembers)
      .innerJoin(
        cases,
        and(
          eq(cases.workspaceId, caseMembers.workspaceId),
          eq(cases.id, caseMembers.caseId),
        ),
      )
      .where(
        and(
          eq(caseMembers.workspaceId, scoped.workspaceId),
          eq(caseMembers.caseId, caseId),
          eq(caseMembers.principalId, scoped.actor.principalId),
          isNull(caseMembers.deletedAt),
          isNull(cases.deletedAt),
          eq(cases.state, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (!authority || !["owner", "reviewer"].includes(authority.role))
      throw createGraphQLError(
        "FORBIDDEN",
        "An active case owner or reviewer is required.",
      );
  }
  async function loadVisible(
    scoped: ResearchServiceContext,
    id: string,
    lock = false,
  ) {
    const row = await createResearchAssignmentsRepository(scoped.database).get(
      scoped.workspaceId,
      id,
      lock,
    );
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested assignment was not found.",
      );
    await visibleCase(scoped, row.caseId);
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
      ["workspace:read"],
      write,
    );
    const row = await loadVisible(
      context,
      referenceId(result.responseReference),
    );
    await authorizeMutation(context, row.caseId);
    return row;
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
      await visibleCase(context, input.caseId);
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
      return loadVisible(context, id);
    },
    async events(input: {
      assignmentId: string;
      first?: number | null;
      after?: string | null;
    }) {
      permission(context, "workspace:read");
      await loadVisible(context, input.assignmentId);
      const page = normalizePagination(input);
      const rows = await repository.events(
        context.workspaceId,
        input.assignmentId,
        {
          first: page.first + 1,
          after: afterEventCursor(page.after),
        },
      );
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last ? eventCursor(last) : null,
        },
      };
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
      permission(context, "workspace:read");
      const caseId = input.caseId ?? null;
      const normalized = {
        caseId,
        queueKind: kind(input.queueKind),
        title: text(input.title, "Title", 200)!,
        description: text(input.description, "Description", 4000, false),
        priority: input.priority == null ? 0 : priority(input.priority),
        assigneePrincipalId: input.assigneePrincipalId ?? null,
        dueAt: date(input.dueAt, "Due date"),
      };
      return mutate(
        "research-assignment.create",
        input.idempotencyKey,
        { ...normalized, dueAt: normalized.dueAt?.toISOString() ?? null },
        async (scoped) => {
          await authorizeMutation(scoped, caseId);
          await validateAssignee(
            scoped.database,
            normalized.assigneePrincipalId,
            caseId,
          );
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
            fromEscalationCount: null,
            toEscalationCount: row.escalationCount,
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
              "description",
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
      permission(context, "workspace:read");
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
          await authorizeMutation(scoped, row.caseId);
          await validateAssignee(
            scoped.database,
            input.assigneePrincipalId ?? null,
            row.caseId,
          );
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
            fromEscalationCount: row.escalationCount,
            toEscalationCount: updated.escalationCount,
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
      permission(context, "workspace:read");
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
          await authorizeMutation(scoped, row.caseId);
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
            fromEscalationCount: row.escalationCount,
            toEscalationCount: updated.escalationCount,
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
      permission(context, "workspace:read");
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
          await authorizeMutation(scoped, row.caseId);
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
            fromEscalationCount: row.escalationCount,
            toEscalationCount: updated.escalationCount,
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
