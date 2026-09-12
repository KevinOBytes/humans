import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { files } from "@/db/schema/files";
import {
  aiCitations,
  aiEphemeralInputs,
  aiMessages,
  aiReviewSuggestions,
  aiRuns,
  aiToolCalls,
} from "@/db/schema/ai";
import { auditEvents } from "@/db/schema/operations";
import { deletionRequests, privacyRequests } from "@/db/schema/privacy";
import {
  personWebResearchRuns,
  personWebResearchSources,
} from "@/db/schema/person-research";
import { legalHolds } from "@/db/schema/workspaces";
import { people } from "@/db/schema/people";
import { newId } from "@/db/id";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { ensureArchivedFileCleanupJob } from "@/modules/files/cleanup";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { planPersonArtifactDeletion } from "./artifact-retention";

const MAX_DELETION_BATCH = 100;
const WORKER_ACTOR = "worker:deletion";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type DeletionScope = {
  personIds: readonly string[];
  fileIds: readonly string[];
};

export function hasAmbiguousAiMessageLineage(
  rows: readonly { role: string; aiRunId: string | null }[],
) {
  return rows.some((row) => row.role === "assistant" && row.aiRunId == null);
}

function parseScope(value: unknown): DeletionScope | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const parseIds = (input: unknown): readonly string[] | null => {
    if (input === undefined) return [];
    if (
      !Array.isArray(input) ||
      input.length > MAX_DELETION_BATCH ||
      input.some((item) => typeof item !== "string" || !UUID.test(item))
    ) {
      return null;
    }
    const ids = input.map((item) => item.toLowerCase());
    return new Set(ids).size === ids.length ? ids : null;
  };
  const personIds = parseIds(source.personIds);
  const fileIds = parseIds(source.fileIds);
  if (
    personIds == null ||
    fileIds == null ||
    (personIds.length === 0 && fileIds.length === 0)
  ) {
    return null;
  }
  return { fileIds, personIds };
}

function auditRequest(input: {
  database: Database;
  action: string;
  requestId: string;
  resourceId: string;
  workspaceId: string;
  redactedDiff: Record<string, unknown>;
  outcome: "failure" | "success";
}) {
  return input.database.insert(auditEvents).values({
    id: newId(),
    workspaceId: input.workspaceId,
    actorUserId: null,
    sessionId: null,
    apiKeyId: null,
    action: input.action,
    resourceKind: "deletion_request",
    resourceId: input.resourceId,
    requestId: input.requestId,
    redactedDiff: input.redactedDiff,
    outcome: input.outcome,
  });
}

/**
 * Executes approved, workspace-scoped deletion requests as a bounded worker
 * transaction. Selected resources are soft-deleted only after all of them
 * clear active legal holds. File objects are handed to the existing durable
 * cleanup job; raw identifiers and personal values never enter audit output.
 */
export async function executeApprovedDeletionRequests(input: {
  database: Database;
  encryptionKey: string;
  limit?: number;
  now?: Date;
  searchIndexMaintenance?: SearchIndexMaintenance;
}): Promise<number> {
  const limit = input.limit ?? MAX_DELETION_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DELETION_BATCH) {
    throw new TypeError("Invalid deletion request batch size");
  }
  if (!/^[0-9a-f]{64}$/iu.test(input.encryptionKey)) {
    throw new TypeError("Invalid deletion worker encryption key");
  }
  const now = input.now ?? new Date();
  const searchIndexMaintenance = input.searchIndexMaintenance;
  let completed = 0;

  const requests = await input.database
    .select()
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.state, "approved"),
        isNull(deletionRequests.deletedAt),
      ),
    )
    // Candidates are only read here. Lock each request after taking its
    // workspace policy lock below, preserving the same lock order as
    // policy mutations and avoiding advisory-lock/request-row deadlocks.
    .orderBy(
      asc(deletionRequests.workspaceId),
      asc(deletionRequests.createdAt),
      asc(deletionRequests.id),
    )
    .limit(limit);

  for (const candidate of requests) {
    await input.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${candidate.workspaceId}, 0))`,
      );
      const [request] = await transaction
        .select()
        .from(deletionRequests)
        .where(
          and(
            eq(deletionRequests.workspaceId, candidate.workspaceId),
            eq(deletionRequests.id, candidate.id),
            eq(deletionRequests.state, "approved"),
            isNull(deletionRequests.deletedAt),
          ),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!request) return;

      // New governed requests may only execute after verified approval and
      // their schedule. Historical deletion requests retain their old path.
      const [governed] = await transaction
        .select()
        .from(privacyRequests)
        .where(
          and(
            eq(privacyRequests.workspaceId, request.workspaceId),
            eq(privacyRequests.legacyDeletionRequestId, request.id),
          ),
        )
        .limit(1);
      if (
        governed &&
        !governed.idempotencyHash.startsWith("legacy:") &&
        (governed.state !== "fulfilling" ||
          !governed.verifiedAt ||
          !governed.reviewedBy ||
          governed.executeAfter > now ||
          governed.deletedAt)
      )
        return;

      const scope = parseScope(request.scope);
      const requestId = `worker:deletion:${request.id}`;
      if (!scope) {
        await transaction
          .update(deletionRequests)
          .set({
            state: "rejected",
            reviewNotes: "The deletion scope is invalid.",
            updatedAt: now,
            updatedBy: WORKER_ACTOR,
            version: sql`${deletionRequests.version} + 1`,
          })
          .where(
            and(
              eq(deletionRequests.workspaceId, request.workspaceId),
              eq(deletionRequests.id, request.id),
              eq(deletionRequests.state, "approved"),
              eq(deletionRequests.version, request.version),
            ),
          );
        await auditRequest({
          database: transaction as unknown as Database,
          action: "deletion_request.rejected",
          requestId,
          resourceId: request.id,
          workspaceId: request.workspaceId,
          redactedDiff: { reason: "invalid_scope" },
          outcome: "failure",
        });
        return;
      }

      const personRows = scope.personIds.length
        ? await transaction
            .select({
              id: people.id,
              sensitivity: people.sensitivity,
              version: people.version,
            })
            .from(people)
            .where(
              and(
                eq(people.workspaceId, request.workspaceId),
                inArray(people.id, scope.personIds),
                isNull(people.deletedAt),
              ),
            )
            .for("update")
        : [];
      const fileRows = scope.fileIds.length
        ? await transaction
            .select({
              createdBy: files.createdBy,
              id: files.id,
              version: files.version,
            })
            .from(files)
            .where(
              and(
                eq(files.workspaceId, request.workspaceId),
                inArray(files.id, scope.fileIds),
                isNull(files.deletedAt),
              ),
            )
            .for("update")
        : [];

      const webRunRows = scope.personIds.length
        ? await transaction
            .select({ id: personWebResearchRuns.id })
            .from(personWebResearchRuns)
            .where(
              and(
                eq(personWebResearchRuns.workspaceId, request.workspaceId),
                inArray(personWebResearchRuns.personId, scope.personIds),
              ),
            )
        : [];
      const aiRunRows = scope.personIds.length
        ? await transaction
            .select({
              id: aiRuns.id,
              messageId: aiRuns.messageId,
              threadId: aiRuns.threadId,
            })
            .from(aiRuns)
            .where(
              and(
                eq(aiRuns.workspaceId, request.workspaceId),
                or(
                  ...scope.personIds.map(
                    (personId) =>
                      sql`${aiRuns.reviewPersonIds} @> ${JSON.stringify([personId])}::jsonb`,
                  ),
                ),
              ),
            )
        : [];
      const aiRunIds = aiRunRows.map((row) => row.id);
      const aiEphemeralInputRows = aiRunIds.length
        ? await transaction
            .select({
              id: aiEphemeralInputs.id,
              aiRunId: aiEphemeralInputs.aiRunId,
            })
            .from(aiEphemeralInputs)
            .where(
              and(
                eq(aiEphemeralInputs.workspaceId, request.workspaceId),
                inArray(aiEphemeralInputs.aiRunId, aiRunIds),
              ),
            )
        : [];
      const aiCitationRows = aiRunIds.length
        ? await transaction
            .select({ id: aiCitations.id, aiRunId: aiCitations.aiRunId })
            .from(aiCitations)
            .where(
              and(
                eq(aiCitations.workspaceId, request.workspaceId),
                inArray(aiCitations.aiRunId, aiRunIds),
              ),
            )
        : [];
      const aiThreadIds = [...new Set(aiRunRows.map((row) => row.threadId))];
      const ambiguousAssistantRows = aiThreadIds.length
        ? await transaction
            .select({ role: aiMessages.role, aiRunId: aiMessages.aiRunId })
            .from(aiMessages)
            .where(
              and(
                eq(aiMessages.workspaceId, request.workspaceId),
                inArray(aiMessages.threadId, aiThreadIds),
                eq(aiMessages.role, "assistant"),
                isNull(aiMessages.aiRunId),
              ),
            )
        : [];
      const webSourceRows = scope.personIds.length
        ? await transaction
            .select({ id: personWebResearchSources.id })
            .from(personWebResearchSources)
            .where(
              and(
                eq(personWebResearchSources.workspaceId, request.workspaceId),
                inArray(personWebResearchSources.personId, scope.personIds),
              ),
            )
        : [];
      const suggestionRows = scope.personIds.length
        ? await transaction
            .select({
              accepted: aiReviewSuggestions.status,
              aiRunId: aiReviewSuggestions.aiRunId,
              id: aiReviewSuggestions.id,
            })
            .from(aiReviewSuggestions)
            .where(
              and(
                eq(aiReviewSuggestions.workspaceId, request.workspaceId),
                inArray(aiReviewSuggestions.personId, scope.personIds),
              ),
            )
        : [];
      const artifacts = [
        ...aiRunRows.map((row) => ({ id: row.id, kind: "ai_run" as const })),
        ...aiEphemeralInputRows.map((row) => ({
          id: row.id,
          kind: "ai_ephemeral_input" as const,
        })),
        ...aiCitationRows.map((row) => ({
          id: row.id,
          kind: "ai_citation" as const,
        })),
        ...webRunRows.map((row) => ({ id: row.id, kind: "web_run" as const })),
        ...webSourceRows.map((row) => ({
          id: row.id,
          kind: "web_source" as const,
        })),
        ...suggestionRows.map((row) => ({
          accepted: row.accepted === "accepted",
          id: row.id,
          kind: "ai_suggestion" as const,
        })),
      ];
      const holdArtifactPredicates = [
        ...(aiThreadIds.length
          ? [
              and(
                eq(legalHolds.resourceKind, "ai_thread"),
                inArray(legalHolds.resourceId, aiThreadIds),
              ),
            ]
          : []),
        ...(aiRunRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "ai_run"),
                inArray(
                  legalHolds.resourceId,
                  aiRunRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(aiEphemeralInputRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "ai_ephemeral_input"),
                inArray(
                  legalHolds.resourceId,
                  aiEphemeralInputRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(aiCitationRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "ai_citation"),
                inArray(
                  legalHolds.resourceId,
                  aiCitationRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(webRunRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "person_web_research_run"),
                inArray(
                  legalHolds.resourceId,
                  webRunRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(webSourceRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "person_web_research_source"),
                inArray(
                  legalHolds.resourceId,
                  webSourceRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(suggestionRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "ai_suggestion"),
                inArray(
                  legalHolds.resourceId,
                  suggestionRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(() => {
          const aiRunIds = suggestionRows
            .map((row) => row.aiRunId)
            .filter((id): id is string => Boolean(id));
          return aiRunIds.length
            ? [
                and(
                  eq(legalHolds.resourceKind, "ai_run"),
                  inArray(legalHolds.resourceId, aiRunIds),
                ),
              ]
            : [];
        })(),
      ];
      const artifactHolds = holdArtifactPredicates.length
        ? await transaction
            .select({ resourceId: legalHolds.resourceId })
            .from(legalHolds)
            .where(
              and(
                eq(legalHolds.workspaceId, request.workspaceId),
                eq(legalHolds.state, "active"),
                isNull(legalHolds.deletedAt),
                or(...holdArtifactPredicates),
              ),
            )
        : [];
      const artifactPlan = planPersonArtifactDeletion({
        artifacts,
        heldIds: new Set(artifactHolds.map((hold) => hold.resourceId)),
      });

      // A deletion request is an explicit resource set. Fail closed when an
      // ID is stale, already deleted, or belongs to another workspace rather
      // than silently completing a partial (or empty) deletion.
      if (
        personRows.length !== scope.personIds.length ||
        fileRows.length !== scope.fileIds.length
      ) {
        await transaction
          .update(deletionRequests)
          .set({
            state: "rejected",
            reviewNotes: "The deletion scope contains unavailable resources.",
            updatedAt: now,
            updatedBy: WORKER_ACTOR,
            version: sql`${deletionRequests.version} + 1`,
          })
          .where(
            and(
              eq(deletionRequests.workspaceId, request.workspaceId),
              eq(deletionRequests.id, request.id),
              eq(deletionRequests.state, "approved"),
              eq(deletionRequests.version, request.version),
            ),
          );
        await auditRequest({
          database: transaction as unknown as Database,
          action: "deletion_request.rejected",
          requestId,
          resourceId: request.id,
          workspaceId: request.workspaceId,
          redactedDiff: { reason: "scope_unavailable" },
          outcome: "failure",
        });
        return;
      }

      if (hasAmbiguousAiMessageLineage(ambiguousAssistantRows)) {
        const blockedMarker =
          "Deletion requires AI message lineage review before execution.";
        if (request.reviewNotes !== blockedMarker) {
          await transaction
            .update(deletionRequests)
            .set({
              reviewNotes: blockedMarker,
              updatedAt: now,
              updatedBy: WORKER_ACTOR,
              version: sql`${deletionRequests.version} + 1`,
            })
            .where(
              and(
                eq(deletionRequests.workspaceId, request.workspaceId),
                eq(deletionRequests.id, request.id),
                eq(deletionRequests.state, "approved"),
                eq(deletionRequests.version, request.version),
              ),
            );
          await auditRequest({
            database: transaction as unknown as Database,
            action: "deletion_request.blocked",
            requestId,
            resourceId: request.id,
            workspaceId: request.workspaceId,
            redactedDiff: { reason: "ambiguous_ai_message_lineage" },
            outcome: "failure",
          });
        }
        return;
      }

      const holdPredicates = [
        ...(personRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "person"),
                inArray(
                  legalHolds.resourceId,
                  personRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...(fileRows.length
          ? [
              and(
                eq(legalHolds.resourceKind, "file"),
                inArray(
                  legalHolds.resourceId,
                  fileRows.map((row) => row.id),
                ),
              ),
            ]
          : []),
        ...holdArtifactPredicates,
      ];
      const holds = holdPredicates.length
        ? await transaction
            .select({ id: legalHolds.id })
            .from(legalHolds)
            .where(
              and(
                eq(legalHolds.workspaceId, request.workspaceId),
                eq(legalHolds.state, "active"),
                isNull(legalHolds.deletedAt),
                or(...holdPredicates),
              ),
            )
        : [];
      if (holds.length > 0) {
        const blockedMarker = "Deletion blocked by active legal hold.";
        if (request.reviewNotes !== blockedMarker) {
          await transaction
            .update(deletionRequests)
            .set({
              reviewNotes: blockedMarker,
              updatedAt: now,
              updatedBy: WORKER_ACTOR,
              version: sql`${deletionRequests.version} + 1`,
            })
            .where(
              and(
                eq(deletionRequests.workspaceId, request.workspaceId),
                eq(deletionRequests.id, request.id),
                eq(deletionRequests.state, "approved"),
                eq(deletionRequests.version, request.version),
              ),
            );
          await auditRequest({
            database: transaction as unknown as Database,
            action: "deletion_request.blocked",
            requestId,
            resourceId: request.id,
            workspaceId: request.workspaceId,
            redactedDiff: { reason: "active_legal_hold" },
            outcome: "failure",
          });
        }
        return;
      }

      const [deleting] = await transaction
        .update(deletionRequests)
        .set({
          state: "deleting",
          updatedAt: now,
          updatedBy: WORKER_ACTOR,
          version: sql`${deletionRequests.version} + 1`,
        })
        .where(
          and(
            eq(deletionRequests.workspaceId, request.workspaceId),
            eq(deletionRequests.id, request.id),
            eq(deletionRequests.state, "approved"),
            eq(deletionRequests.version, request.version),
          ),
        )
        .returning({ version: deletionRequests.version });
      if (!deleting) return;

      if (personRows.length) {
        await transaction
          .update(people)
          .set({
            status: "archived",
            deletedAt: now,
            deletedBy: WORKER_ACTOR,
            updatedAt: now,
            updatedBy: WORKER_ACTOR,
            version: sql`${people.version} + 1`,
          })
          .where(
            and(
              eq(people.workspaceId, request.workspaceId),
              inArray(
                people.id,
                personRows.map((row) => row.id),
              ),
              isNull(people.deletedAt),
            ),
          );
      }
      if (artifactPlan.aiSuggestionIds.length) {
        await transaction
          .delete(aiReviewSuggestions)
          .where(
            and(
              eq(aiReviewSuggestions.workspaceId, request.workspaceId),
              inArray(aiReviewSuggestions.id, artifactPlan.aiSuggestionIds),
            ),
          );
      }
      if (artifactPlan.aiRunIds.length) {
        const runIds = artifactPlan.aiRunIds;
        const messageIds = aiRunRows
          .filter((row) => runIds.includes(row.id) && row.messageId)
          .map((row) => row.messageId!);
        await transaction
          .delete(aiEphemeralInputs)
          .where(
            and(
              eq(aiEphemeralInputs.workspaceId, request.workspaceId),
              inArray(aiEphemeralInputs.aiRunId, runIds),
            ),
          );
        await transaction
          .delete(aiCitations)
          .where(
            and(
              eq(aiCitations.workspaceId, request.workspaceId),
              inArray(aiCitations.aiRunId, runIds),
            ),
          );
        await transaction
          .delete(aiToolCalls)
          .where(
            and(
              eq(aiToolCalls.workspaceId, request.workspaceId),
              inArray(aiToolCalls.aiRunId, runIds),
            ),
          );
        await transaction
          .delete(aiRuns)
          .where(
            and(
              eq(aiRuns.workspaceId, request.workspaceId),
              inArray(aiRuns.id, runIds),
            ),
          );
        const remainingRunThreads = aiThreadIds.length
          ? await transaction
              .select({ threadId: aiRuns.threadId })
              .from(aiRuns)
              .where(
                and(
                  eq(aiRuns.workspaceId, request.workspaceId),
                  inArray(aiRuns.threadId, aiThreadIds),
                ),
              )
          : [];
        const threadsWithoutRuns = aiThreadIds.filter(
          (threadId) =>
            !remainingRunThreads.some((row) => row.threadId === threadId),
        );
        if (threadsWithoutRuns.length) {
          await transaction
            .delete(aiMessages)
            .where(
              and(
                eq(aiMessages.workspaceId, request.workspaceId),
                inArray(aiMessages.threadId, threadsWithoutRuns),
              ),
            );
        } else if (messageIds.length) {
          await transaction
            .delete(aiMessages)
            .where(
              and(
                eq(aiMessages.workspaceId, request.workspaceId),
                inArray(aiMessages.id, messageIds),
                sql`not exists (select 1 from ${aiRuns} where ${aiRuns.workspaceId} = ${request.workspaceId}::uuid and ${aiRuns.messageId} = ${aiMessages.id})`,
              ),
            );
        }
      }
      if (artifactPlan.webSourceIds.length) {
        await transaction
          .delete(personWebResearchSources)
          .where(
            and(
              eq(personWebResearchSources.workspaceId, request.workspaceId),
              inArray(personWebResearchSources.id, artifactPlan.webSourceIds),
            ),
          );
      }
      if (artifactPlan.webRunIds.length) {
        await transaction
          .delete(personWebResearchRuns)
          .where(
            and(
              eq(personWebResearchRuns.workspaceId, request.workspaceId),
              inArray(personWebResearchRuns.id, artifactPlan.webRunIds),
            ),
          );
      }
      if (fileRows.length) {
        await transaction
          .update(files)
          .set({
            deletedAt: now,
            deletedBy: WORKER_ACTOR,
            updatedAt: now,
            updatedBy: WORKER_ACTOR,
            version: sql`${files.version} + 1`,
          })
          .where(
            and(
              eq(files.workspaceId, request.workspaceId),
              inArray(
                files.id,
                fileRows.map((row) => row.id),
              ),
              isNull(files.deletedAt),
            ),
          );
        for (const file of fileRows) {
          await ensureArchivedFileCleanupJob({
            createdBy: file.createdBy,
            database: transaction as unknown as Database,
            encryptionKey: input.encryptionKey,
            fileId: file.id,
            workspaceId: request.workspaceId,
          });
        }
      }
      if (searchIndexMaintenance && personRows.length) {
        await searchIndexMaintenance.apply(
          transaction as unknown as Database,
          personRows.map((person) => ({
            action: "remove" as const,
            sourceId: person.id,
            sourceKind: "person" as const,
            sourceVersion: person.version + 1,
            workspaceId: request.workspaceId,
          })),
        );
      }

      await transaction
        .update(deletionRequests)
        .set({
          state: "completed",
          completedAt: now,
          updatedAt: now,
          updatedBy: WORKER_ACTOR,
          version: sql`${deletionRequests.version} + 1`,
        })
        .where(
          and(
            eq(deletionRequests.workspaceId, request.workspaceId),
            eq(deletionRequests.id, request.id),
            eq(deletionRequests.state, "deleting"),
          ),
        );
      await auditRequest({
        database: transaction as unknown as Database,
        action: "deletion_request.completed",
        requestId,
        resourceId: request.id,
        workspaceId: request.workspaceId,
        redactedDiff: {
          files: fileRows.length,
          people: personRows.length,
        },
        outcome: "success",
      });
      completed += 1;
    });
  }
  return completed;
}
