import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/db/id";
import {
  aiCitations,
  aiEphemeralInputs,
  aiReviewSuggestions,
  aiRuns,
  aiThreads,
} from "@/db/schema/ai";
import { people } from "@/db/schema/people";
import { files } from "@/db/schema/files";
import {
  personWebResearchRuns,
  personWebResearchSources,
} from "@/db/schema/person-research";
import { legalHolds, retentionPolicies } from "@/db/schema/workspaces";
import { createGraphQLError } from "@/graphql/errors";
import {
  canAccessResource,
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { runResearchTransaction } from "@/modules/audit/transactions";

export const privacyResourceKinds = [
  "person",
  "file",
  "ai_thread",
  "ai_run",
  "ai_ephemeral_input",
  "ai_suggestion",
  "ai_citation",
  "person_web_research_run",
  "person_web_research_source",
] as const;
export type PrivacyResourceKind = (typeof privacyResourceKinds)[number];
export type PrivacyResource = {
  resourceKind: PrivacyResourceKind;
  resourceId: string;
};
export function privacyArtifactVisible(input: {
  actorPrincipalId: string | null;
  threadOwnerId?: string | null;
  threadSharing?: string | null;
  personVisible?: boolean;
  requiresPersonVisibility: boolean;
}) {
  const threadVisible =
    input.threadSharing !== "private" ||
    (input.threadOwnerId != null &&
      input.threadOwnerId === input.actorPrincipalId);
  return (
    threadVisible &&
    (!input.requiresPersonVisibility || input.personVisible === true)
  );
}
function isPrivacyResourceKind(value: unknown): value is PrivacyResourceKind {
  return (
    typeof value === "string" &&
    (privacyResourceKinds as readonly string[]).includes(value)
  );
}
export function privacyPermission(
  context: ResearchServiceContext,
  manage = false,
) {
  if (
    context.actor.type !== "user" ||
    !context.permissions.has(manage ? "workspace:update" : "workspace:read")
  )
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}
export async function privacyPolicyLock(context: ResearchServiceContext) {
  await context.database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${context.workspaceId}, 0))`,
  );
}
export async function requirePrivacyResource(
  context: ResearchServiceContext,
  input: PrivacyResource,
  includeDeleted = false,
) {
  if (
    !z.uuid().safeParse(input.resourceId).success ||
    !isPrivacyResourceKind(input.resourceKind)
  )
    throw createGraphQLError("VALIDATION_FAILED", "The resource is invalid.");
  const permission =
    input.resourceKind === "person" || input.resourceKind.startsWith("person_")
      ? "person:read"
      : input.resourceKind === "file"
        ? "file:read"
        : "analysis:read";
  if (!context.permissions.has(permission))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
  if (input.resourceKind === "person" || input.resourceKind === "file") {
    const table = input.resourceKind === "person" ? people : files;
    const [row] = await context.database
      .select({
        id: table.id,
        sensitivity: table.sensitivity,
        createdAt: table.createdAt,
      })
      .from(table)
      .where(
        and(
          eq(table.workspaceId, context.workspaceId),
          eq(table.id, input.resourceId),
          includeDeleted ? undefined : isNull(table.deletedAt),
        ),
      )
      .limit(1);
    if (
      !row ||
      !(await canAccessResource(context.database, context, {
        id: row.id,
        resourceKind: input.resourceKind,
        sensitivity: row.sensitivity,
      }))
    )
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    return row;
  }
  const visiblePeople = async (personIds: readonly string[]) => {
    const ids = [...new Set(personIds)];
    if (!ids.length) return true;
    if (!context.permissions.has("person:read")) return false;
    const rows = await context.database
      .select({ id: people.id, sensitivity: people.sensitivity })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, context.workspaceId),
          inArray(people.id, ids),
          includeDeleted ? undefined : isNull(people.deletedAt),
        ),
      );
    if (rows.length !== ids.length) return false;
    for (const person of rows) {
      if (
        !(await canAccessResource(context.database, context, {
          id: person.id,
          resourceKind: "person",
          sensitivity: person.sensitivity,
        }))
      )
        return false;
    }
    return true;
  };
  const visibleThread = async (threadId: string) => {
    const [thread] = await context.database
      .select({
        createdAt: aiThreads.createdAt,
        ownerId: aiThreads.ownerId,
        sharing: aiThreads.sharing,
      })
      .from(aiThreads)
      .where(
        and(
          eq(aiThreads.workspaceId, context.workspaceId),
          eq(aiThreads.id, threadId),
          includeDeleted ? undefined : isNull(aiThreads.deletedAt),
        ),
      )
      .limit(1);
    return thread ?? null;
  };
  const visibleRun = async (runId: string) => {
    const [run] = await context.database
      .select({
        id: aiRuns.id,
        createdAt: aiRuns.createdAt,
        reviewPersonIds: aiRuns.reviewPersonIds,
        threadId: aiRuns.threadId,
      })
      .from(aiRuns)
      .where(
        and(eq(aiRuns.workspaceId, context.workspaceId), eq(aiRuns.id, runId)),
      )
      .limit(1);
    if (!run) return null;
    const thread = await visibleThread(run.threadId);
    const personVisible = await visiblePeople(run.reviewPersonIds);
    if (
      !thread ||
      !privacyArtifactVisible({
        actorPrincipalId: context.actor.principalId,
        threadOwnerId: thread.ownerId,
        threadSharing: thread.sharing,
        personVisible,
        requiresPersonVisibility: run.reviewPersonIds.length > 0,
      })
    )
      return null;
    return run;
  };
  let visible = false;
  let createdAt: Date | undefined;
  if (input.resourceKind === "ai_thread") {
    const thread = await visibleThread(input.resourceId);
    visible = Boolean(
      thread &&
      privacyArtifactVisible({
        actorPrincipalId: context.actor.principalId,
        threadOwnerId: thread.ownerId,
        threadSharing: thread.sharing,
        requiresPersonVisibility: false,
      }),
    );
    createdAt = thread?.createdAt;
  } else if (input.resourceKind === "ai_run") {
    const run = await visibleRun(input.resourceId);
    visible = Boolean(run);
    createdAt = run?.createdAt;
  } else if (input.resourceKind === "ai_ephemeral_input") {
    const [row] = await context.database
      .select({ aiRunId: aiEphemeralInputs.aiRunId })
      .from(aiEphemeralInputs)
      .where(
        and(
          eq(aiEphemeralInputs.workspaceId, context.workspaceId),
          eq(aiEphemeralInputs.id, input.resourceId),
        ),
      )
      .limit(1);
    const run = row ? await visibleRun(row.aiRunId) : null;
    visible = Boolean(run);
    createdAt = run?.createdAt;
  } else if (input.resourceKind === "ai_citation") {
    const [row] = await context.database
      .select({ aiRunId: aiCitations.aiRunId })
      .from(aiCitations)
      .where(
        and(
          eq(aiCitations.workspaceId, context.workspaceId),
          eq(aiCitations.id, input.resourceId),
        ),
      )
      .limit(1);
    const run = row ? await visibleRun(row.aiRunId) : null;
    visible = Boolean(run);
    createdAt = run?.createdAt;
  } else if (input.resourceKind === "ai_suggestion") {
    const [row] = await context.database
      .select({
        aiRunId: aiReviewSuggestions.aiRunId,
        createdAt: aiReviewSuggestions.createdAt,
        personId: aiReviewSuggestions.personId,
        webRunId: aiReviewSuggestions.webRunId,
      })
      .from(aiReviewSuggestions)
      .where(
        and(
          eq(aiReviewSuggestions.workspaceId, context.workspaceId),
          eq(aiReviewSuggestions.id, input.resourceId),
        ),
      )
      .limit(1);
    if (row) {
      const run = row.aiRunId ? await visibleRun(row.aiRunId) : null;
      const personVisible = await visiblePeople([row.personId]);
      visible = Boolean(
        (run || row.webRunId) &&
        personVisible &&
        (!row.webRunId ||
          (
            await context.database
              .select({ id: personWebResearchRuns.id })
              .from(personWebResearchRuns)
              .where(
                and(
                  eq(personWebResearchRuns.workspaceId, context.workspaceId),
                  eq(personWebResearchRuns.id, row.webRunId),
                  eq(personWebResearchRuns.personId, row.personId),
                ),
              )
              .limit(1)
          ).length > 0),
      );
      createdAt = row.createdAt;
    }
  } else if (
    input.resourceKind === "person_web_research_run" ||
    input.resourceKind === "person_web_research_source"
  ) {
    const table =
      input.resourceKind === "person_web_research_run"
        ? personWebResearchRuns
        : personWebResearchSources;
    const [row] = await context.database
      .select({
        createdAt: table.createdAt,
        personId: table.personId,
      })
      .from(table)
      .where(
        and(
          eq(table.workspaceId, context.workspaceId),
          eq(table.id, input.resourceId),
        ),
      )
      .limit(1);
    visible = Boolean(row && (await visiblePeople(row ? [row.personId] : [])));
    createdAt = row?.createdAt;
  }
  if (!visible)
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  return { id: input.resourceId, createdAt: createdAt ?? new Date() };
}
export async function hasLegalHold(
  context: Pick<ResearchServiceContext, "database" | "workspaceId">,
  resource: PrivacyResource,
) {
  const [hold] = await context.database
    .select({ id: legalHolds.id })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.workspaceId, context.workspaceId),
        eq(legalHolds.resourceKind, resource.resourceKind),
        eq(legalHolds.resourceId, resource.resourceId),
        eq(legalHolds.state, "active"),
        isNull(legalHolds.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(hold);
}
export function retentionDecision(input: {
  now: Date;
  createdAt: Date;
  held: boolean;
  policy: {
    id: string;
    retentionDays: number;
    deletionBehavior: string;
  } | null;
}): {
  state:
    | "retained"
    | "review_required"
    | "eligible_for_deletion"
    | "blocked_by_legal_hold";
  policyId: string | null;
  reason: string;
} {
  const { policy } = input;
  if (
    ![input.now.getTime(), input.createdAt.getTime()].every(Number.isFinite) ||
    (policy &&
      (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 0))
  )
    throw new TypeError("Invalid retention inputs");
  const policyId = policy?.id ?? null;
  if (input.held)
    return {
      state: "blocked_by_legal_hold",
      policyId,
      reason: "active_legal_hold",
    };
  if (!policy)
    return { state: "review_required", policyId, reason: "missing_policy" };
  if (
    input.now.getTime() <
    input.createdAt.getTime() + policy.retentionDays * 86_400_000
  )
    return { state: "retained", policyId, reason: "retention_period_active" };
  return policy.deletionBehavior === "soft_delete"
    ? {
        state: "eligible_for_deletion",
        policyId,
        reason: "retention_elapsed_soft_delete_requires_approval",
      }
    : {
        state: "review_required",
        policyId,
        reason: "retention_elapsed_requires_review",
      };
}
export async function evaluateRetention(
  context: ResearchServiceContext,
  resource: PrivacyResource,
) {
  privacyPermission(context);
  const row = await requirePrivacyResource(context, resource);
  const [policy] = await context.database
    .select()
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.workspaceId, context.workspaceId),
        eq(retentionPolicies.resourceKind, resource.resourceKind),
        isNull(retentionPolicies.deletedAt),
      ),
    )
    .limit(1);
  return retentionDecision({
    now: new Date(),
    createdAt: row.createdAt,
    held: await hasLegalHold(context, resource),
    policy: policy ?? null,
  });
}
export function createRetentionService(context: ResearchServiceContext) {
  return {
    evaluateRetention: (resource: PrivacyResource) =>
      evaluateRetention(context, resource),
    async createLegalHold(
      input: PrivacyResource & { reason: string; authority: string },
    ) {
      privacyPermission(context, true);
      const parsed = z
        .object({
          reason: z.string().trim().min(1).max(2048),
          authority: z.string().trim().min(1).max(512),
        })
        .parse(input);
      return runResearchTransaction(
        context,
        { requiredPermissions: ["workspace:update"] },
        async (scoped) => {
          await privacyPolicyLock(scoped);
          await requirePrivacyResource(scoped, input);
          const [row] = await scoped.database
            .insert(legalHolds)
            .values({
              id: newId(),
              workspaceId: scoped.workspaceId,
              resourceKind: input.resourceKind,
              resourceId: input.resourceId,
              ...parsed,
              createdBy: scoped.actor.principalId,
              updatedBy: scoped.actor.principalId,
            })
            .returning();
          const auditReference = await createAuditService(scoped).write(
            scoped.database,
            {
              action: "privacy.legal_hold.approved",
              resourceKind: "legal_hold",
              resourceId: row!.id,
              changedFields: ["state", "authority", "reason"],
            },
          );
          return { ...row!, auditReference };
        },
      );
    },
    async releaseLegalHold(input: {
      id: string;
      expectedVersion: number;
      reason: string;
    }) {
      privacyPermission(context, true);
      const reason = z.string().trim().min(1).max(2048).parse(input.reason);
      return runResearchTransaction(
        context,
        { requiredPermissions: ["workspace:update"] },
        async (scoped) => {
          await privacyPolicyLock(scoped);
          const [row] = await scoped.database
            .select()
            .from(legalHolds)
            .where(
              and(
                eq(legalHolds.workspaceId, scoped.workspaceId),
                eq(legalHolds.id, input.id),
                isNull(legalHolds.deletedAt),
              ),
            )
            .for("update");
          if (!row)
            throw createGraphQLError(
              "NOT_FOUND",
              "The requested resource was not found.",
            );
          await requirePrivacyResource(
            scoped,
            {
              resourceKind: row.resourceKind as PrivacyResource["resourceKind"],
              resourceId: row.resourceId,
            },
            true,
          );
          if (
            row.createdBy === scoped.actor.principalId ||
            row.createdBy === scoped.actor.id ||
            row.state !== "active" ||
            row.version !== input.expectedVersion
          )
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "An independent reviewer and current hold version are required.",
            );
          const [released] = await scoped.database
            .update(legalHolds)
            .set({
              state: "released",
              releasedAt: new Date(),
              releasedBy: scoped.actor.principalId,
              releaseReason: reason,
              updatedAt: new Date(),
              updatedBy: scoped.actor.principalId,
              version: row.version + 1,
            })
            .where(eq(legalHolds.id, row.id))
            .returning();
          const auditReference = await createAuditService(scoped).write(
            scoped.database,
            {
              action: "privacy.legal_hold.released",
              resourceKind: "legal_hold",
              resourceId: row.id,
              changedFields: ["state", "releaseReason"],
            },
          );
          return { ...released!, auditReference };
        },
      );
    },
    async listLegalHolds(input: PrivacyResource & { first?: number | null }) {
      privacyPermission(context);
      await requirePrivacyResource(context, input, true);
      const first = input.first ?? 25;
      if (!Number.isSafeInteger(first) || first < 1 || first > 100)
        throw createGraphQLError("VALIDATION_FAILED", "Invalid page size.");
      return context.database
        .select()
        .from(legalHolds)
        .where(
          and(
            eq(legalHolds.workspaceId, context.workspaceId),
            eq(legalHolds.resourceKind, input.resourceKind),
            eq(legalHolds.resourceId, input.resourceId),
            isNull(legalHolds.deletedAt),
          ),
        )
        .orderBy(asc(legalHolds.id))
        .limit(first);
    },
  };
}
export const createLegalHold = (
  context: ResearchServiceContext,
  input: Parameters<
    ReturnType<typeof createRetentionService>["createLegalHold"]
  >[0],
) => createRetentionService(context).createLegalHold(input);
export const releaseLegalHold = (
  context: ResearchServiceContext,
  input: Parameters<
    ReturnType<typeof createRetentionService>["releaseLegalHold"]
  >[0],
) => createRetentionService(context).releaseLegalHold(input);
export const listLegalHolds = (
  context: ResearchServiceContext,
  input: Parameters<
    ReturnType<typeof createRetentionService>["listLegalHolds"]
  >[0],
) => createRetentionService(context).listLegalHolds(input);
