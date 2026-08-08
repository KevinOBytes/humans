import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { files } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { deletionRequests } from "@/db/schema/privacy";
import { legalHolds } from "@/db/schema/workspaces";
import { people } from "@/db/schema/people";
import { newId } from "@/db/id";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { ensureArchivedFileCleanupJob } from "@/modules/files/cleanup";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";

const MAX_DELETION_BATCH = 100;
const WORKER_ACTOR = "worker:deletion";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type DeletionScope = {
  personIds: readonly string[];
  fileIds: readonly string[];
};

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
