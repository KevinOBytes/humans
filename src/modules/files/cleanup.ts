import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";

import { newId } from "@/db/id";
import { files, uploadSessions } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import type { ObjectStore } from "@/lib/storage/types";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { JobExecutionError } from "@/modules/jobs/types";
import { createJobsService, jobPayloadHash } from "@/modules/jobs/service";
import { equalJobHashes } from "@/modules/jobs/types";

const CLEANUP_DELAY_MS = 60 * 60_000;

export function fileCleanupIdempotencyKey(input: {
  encryptionKey: string;
  uploadSessionId: string;
  workspaceId: string;
}): string {
  return createHmac("sha256", Buffer.from(input.encryptionKey, "hex"))
    .update(
      `humans:file-cleanup:v1\0${input.workspaceId}\0${input.uploadSessionId}`,
    )
    .digest("hex");
}

export async function ensureFileCleanupJob(input: {
  createdBy?: string | null;
  database: Database;
  encryptionKey: string;
  expiresAt: Date;
  uploadSessionId: string;
  workspaceId: string;
}) {
  const service = createJobsService({
    database: input.database,
    encryptionKey: input.encryptionKey,
  });
  const payload = {
    kind: "file_cleanup" as const,
    uploadSessionId: input.uploadSessionId,
  };
  const idempotencyKey = fileCleanupIdempotencyKey(input);
  const scheduledAt = new Date(input.expiresAt.getTime() + CLEANUP_DELAY_MS);
  let job;
  try {
    job = await service.enqueue({
      workspaceId: input.workspaceId,
      idempotencyKey,
      payload,
      createdBy: input.createdBy,
      scheduledAt,
    });
  } catch (error) {
    const expectedHash = jobPayloadHash(payload);
    const legacy = await service.repository.getByIdempotency({
      workspaceId: input.workspaceId,
      kind: "file_cleanup",
      idempotencyKey,
    });
    if (
      !legacy ||
      legacy.requestHash !== null ||
      !equalJobHashes(legacy.payloadHash, expectedHash)
    ) {
      throw error;
    }
    job = await service.repository.repairLegacyRequestHash({
      id: legacy.id,
      workspaceId: input.workspaceId,
      payloadHash: expectedHash,
      requestHash: expectedHash,
    });
    if (!job) throw error;
  }
  if (job.state === "completed" || job.state === "dead_letter") {
    const requeued = await service.repository.requeueTerminalCleanup({
      id: job.id,
      workspaceId: input.workspaceId,
      scheduledAt,
    });
    if (requeued) return requeued;
    const current = await service.repository.getById({
      id: job.id,
      workspaceId: input.workspaceId,
    });
    if (current) return current;
  }
  return job;
}

export async function reconcileFileCleanupJobs(input: {
  database: Database;
  encryptionKey: string;
  limit?: number;
}): Promise<number> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 250);
  return input.database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        actorId: uploadSessions.actorId,
        expiresAt: uploadSessions.expiresAt,
        id: uploadSessions.id,
        state: uploadSessions.state,
        workspaceId: uploadSessions.workspaceId,
      })
      .from(uploadSessions)
      .leftJoin(
        files,
        and(
          eq(files.workspaceId, uploadSessions.workspaceId),
          eq(files.id, uploadSessions.fileId),
          isNull(files.deletedAt),
        ),
      )
      .where(
        and(
          isNull(uploadSessions.cleanupCompletedAt),
          or(
            and(
              inArray(uploadSessions.state, ["pending", "verifying"]),
              lte(uploadSessions.expiresAt, sql`clock_timestamp()`),
            ),
            inArray(uploadSessions.state, [
              "rejected",
              "expired",
              "cleanup_pending",
              "completed",
            ]),
          ),
        ),
      )
      .orderBy(asc(uploadSessions.expiresAt), asc(uploadSessions.id))
      .limit(limit)
      .for("update", { of: uploadSessions, skipLocked: true });

    for (const session of candidates) {
      if (session.state === "pending" || session.state === "verifying") {
        await transaction
          .update(uploadSessions)
          .set({
            state: "expired",
            failureCode: "SESSION_EXPIRED",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(uploadSessions.workspaceId, session.workspaceId),
              eq(uploadSessions.id, session.id),
              inArray(uploadSessions.state, ["pending", "verifying"]),
            ),
          );
      }
      await ensureFileCleanupJob({
        database: transaction as unknown as Database,
        encryptionKey: input.encryptionKey,
        workspaceId: session.workspaceId,
        uploadSessionId: session.id,
        expiresAt: session.expiresAt,
        createdBy: session.actorId,
      });
    }
    return candidates.length;
  });
}

export function createFileCleanupService(input: {
  database: Database;
  objectStore: ObjectStore;
}) {
  return {
    async executeFileCleanupJob(job: {
      jobId: string;
      renewLease(): Promise<boolean>;
      signal: AbortSignal;
      uploadSessionId: string;
      workspaceId: string;
    }): Promise<{ resultReferences: readonly string[] }> {
      if (job.signal.aborted) {
        throw job.signal.reason instanceof Error
          ? job.signal.reason
          : new JobExecutionError("worker_draining", "retryable");
      }
      const session = await input.database.transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.workspaceId, job.workspaceId),
              eq(uploadSessions.id, job.uploadSessionId),
              lte(
                uploadSessions.expiresAt,
                sql`clock_timestamp() - interval '1 hour'`,
              ),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) throw new JobExecutionError("cleanup_not_ready", "retryable");
        const completedRetainedFile = row.fileId
          ? await transaction
              .select({ id: files.id, storageKey: files.storageKey })
              .from(files)
              .where(
                and(
                  eq(files.workspaceId, job.workspaceId),
                  eq(files.id, row.fileId),
                  eq(files.quarantineState, "available"),
                  inArray(files.scanState, ["clean", "not_required"]),
                  isNull(files.deletedAt),
                ),
              )
              .limit(1)
          : [];
        const cleanCompletion =
          row.state === "completed" &&
          completedRetainedFile[0]?.storageKey === row.objectKey;
        if (
          ![
            "pending",
            "verifying",
            "rejected",
            "expired",
            "cleanup_pending",
            "completed",
          ].includes(row.state) &&
          !cleanCompletion
        ) {
          throw new JobExecutionError("cleanup_state_conflict", "permanent");
        }
        if (
          !cleanCompletion &&
          row.state !== "cleanup_pending" &&
          row.state !== "completed"
        ) {
          await transaction
            .update(uploadSessions)
            .set({ state: "cleanup_pending", updatedAt: new Date() })
            .where(
              and(
                eq(uploadSessions.workspaceId, job.workspaceId),
                eq(uploadSessions.id, row.id),
              ),
            );
        }
        return { ...row, cleanCompletion };
      });
      if (job.signal.aborted) {
        throw job.signal.reason instanceof Error
          ? job.signal.reason
          : new JobExecutionError("worker_draining", "retryable");
      }
      if (!(await job.renewLease())) {
        throw new JobExecutionError("lease_lost", "retryable");
      }
      if (!session.cleanCompletion) {
        try {
          await input.objectStore.delete({
            workspaceId: job.workspaceId,
            key: session.objectKey,
          });
        } catch {
          throw new JobExecutionError("storage_unavailable", "retryable");
        }
      }
      if (job.signal.aborted) {
        throw job.signal.reason instanceof Error
          ? job.signal.reason
          : new JobExecutionError("worker_draining", "retryable");
      }
      await input.database.transaction(async (transaction) => {
        const [completed] = await transaction
          .update(uploadSessions)
          .set({
            cleanupCompletedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(uploadSessions.workspaceId, job.workspaceId),
              eq(uploadSessions.id, session.id),
              isNull(uploadSessions.cleanupCompletedAt),
            ),
          )
          .returning({ id: uploadSessions.id });
        if (!completed) return;
        await transaction.insert(auditEvents).values({
          id: newId(),
          workspaceId: job.workspaceId,
          actorUserId: null,
          sessionId: null,
          apiKeyId: null,
          action: "file.cleanup_completed",
          resourceKind: "upload_session",
          resourceId: session.id,
          requestId: `worker:${job.jobId}`,
          redactedDiff: {
            deleted: !session.cleanCompletion,
            jobId: job.jobId,
          },
          outcome: "success",
        });
      });
      return { resultReferences: [session.id] };
    },
  };
}
