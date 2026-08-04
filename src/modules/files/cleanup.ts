import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { createHmac } from "node:crypto";

import { newId } from "@/db/id";
import { fileVariants, files, uploadSessions } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import type { ObjectStore } from "@/lib/storage/types";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { JobExecutionError } from "@/modules/jobs/types";
import { createJobsService, jobPayloadHash } from "@/modules/jobs/service";
import { equalJobHashes } from "@/modules/jobs/types";
import { createFilesRepository, type FileObjectLocation } from "./repository";

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

export function archivedFileCleanupIdempotencyKey(input: {
  encryptionKey: string;
  fileId: string;
  workspaceId: string;
}): string {
  return createHmac("sha256", Buffer.from(input.encryptionKey, "hex"))
    .update(
      `humans:archived-file-cleanup:v1\0${input.workspaceId}\0${input.fileId}`,
    )
    .digest("hex");
}

export async function ensureArchivedFileCleanupJob(input: {
  createdBy?: string | null;
  database: Database;
  encryptionKey: string;
  fileId: string;
  workspaceId: string;
}) {
  const service = createJobsService({
    database: input.database,
    encryptionKey: input.encryptionKey,
  });
  const payload = { kind: "file_cleanup" as const, fileId: input.fileId };
  const idempotencyKey = archivedFileCleanupIdempotencyKey(input);
  const scheduledAt = new Date();
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

export async function ensureFileCleanupJob(input: {
  createdBy?: string | null;
  database: Database;
  encryptionKey: string;
  expiresAt: Date;
  uploadSessionId: string;
  workspaceId: string;
  scheduledAt?: Date;
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
  const scheduledAt =
    input.scheduledAt ?? new Date(input.expiresAt.getTime() + CLEANUP_DELAY_MS);
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
  if (input.scheduledAt && job.state === "queued") {
    const scheduled = await service.repository.scheduleQueuedEarlier({
      id: job.id,
      workspaceId: input.workspaceId,
      scheduledAt,
    });
    if (scheduled) return scheduled;
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
        ...(session.state === "cleanup_pending"
          ? { scheduledAt: new Date(0) }
          : {}),
      });
    }
    return candidates.length;
  });
}

export function createFileCleanupService(input: {
  database: Database;
  objectStore: ObjectStore;
  storageBucket?: string;
  storageProvider?: string;
}) {
  return {
    async executeFileCleanupJob(job: {
      fileId?: string;
      jobId: string;
      renewLease(): Promise<boolean>;
      signal: AbortSignal;
      uploadSessionId?: string;
      workspaceId: string;
    }): Promise<{ resultReferences: readonly string[] }> {
      if (job.fileId) {
        return executeArchivedFileCleanupJob(input, {
          fileId: job.fileId,
          jobId: job.jobId,
          renewLease: job.renewLease,
          signal: job.signal,
          workspaceId: job.workspaceId,
        });
      }
      if (!job.uploadSessionId) {
        throw new JobExecutionError("cleanup_target_invalid", "permanent");
      }
      const uploadSessionId = job.uploadSessionId;
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
              eq(uploadSessions.id, uploadSessionId),
              or(
                eq(uploadSessions.state, "cleanup_pending"),
                lte(
                  uploadSessions.expiresAt,
                  sql`clock_timestamp() - interval '1 hour'`,
                ),
              ),
              or(
                isNull(uploadSessions.uploadAttemptId),
                lte(
                  uploadSessions.uploadAttemptExpiresAt,
                  sql`clock_timestamp()`,
                ),
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

async function executeArchivedFileCleanupJob(
  input: {
    database: Database;
    objectStore: ObjectStore;
    storageBucket?: string;
    storageProvider?: string;
  },
  job: {
    fileId: string;
    jobId: string;
    renewLease(): Promise<boolean>;
    signal: AbortSignal;
    workspaceId: string;
  },
): Promise<{ resultReferences: readonly string[] }> {
  if (job.signal.aborted) {
    throw job.signal.reason instanceof Error
      ? job.signal.reason
      : new JobExecutionError("worker_draining", "retryable");
  }
  return input.database.transaction(async (transaction) => {
    const repository = createFilesRepository(
      transaction as unknown as Database,
    );
    const target = await repository.lockArchivedFileCleanupTarget({
      id: job.fileId,
      workspaceId: job.workspaceId,
    });
    if (!target)
      throw new JobExecutionError("archived_file_not_found", "permanent");
    if (target.cleanupCompletedAt) {
      return { resultReferences: [job.fileId] };
    }
    const locations = target.locations;
    assertRuntimeStorageLocation(input, locations);
    await lockAndAssertExclusiveObjectOwnership(
      transaction as unknown as Database,
      {
        fileId: job.fileId,
        locations,
        workspaceId: job.workspaceId,
      },
    );
    for (const location of locations) {
      if (job.signal.aborted) {
        throw job.signal.reason instanceof Error
          ? job.signal.reason
          : new JobExecutionError("worker_draining", "retryable");
      }
      if (!(await job.renewLease())) {
        throw new JobExecutionError("lease_lost", "retryable");
      }
      try {
        await input.objectStore.delete({
          workspaceId: job.workspaceId,
          key: location.storageKey,
        });
      } catch {
        throw new JobExecutionError("storage_unavailable", "retryable");
      }
    }
    const currentTarget = await repository.lockArchivedFileCleanupTarget({
      id: job.fileId,
      workspaceId: job.workspaceId,
    });
    if (
      !currentTarget ||
      currentTarget.cleanupCompletedAt ||
      !sameObjectLocations(locations, currentTarget.locations)
    ) {
      throw new JobExecutionError("archived_file_changed", "retryable");
    }
    const [completed] = await transaction
      .update(files)
      .set({
        cleanupCompletedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(files.workspaceId, job.workspaceId),
          eq(files.id, job.fileId),
          isNotNull(files.deletedAt),
          isNull(files.cleanupCompletedAt),
        ),
      )
      .returning({ id: files.id });
    if (!completed) {
      throw new JobExecutionError("archived_file_changed", "retryable");
    }
    await transaction.insert(auditEvents).values({
      id: newId(),
      workspaceId: job.workspaceId,
      actorUserId: null,
      sessionId: null,
      apiKeyId: null,
      action: "file.cleanup_completed",
      resourceKind: "file",
      resourceId: job.fileId,
      requestId: `worker:${job.jobId}`,
      redactedDiff: { deleted: true, jobId: job.jobId },
      outcome: "success",
    });
    return { resultReferences: [job.fileId] };
  });
}

async function lockAndAssertExclusiveObjectOwnership(
  database: Database,
  input: {
    fileId: string;
    locations: readonly FileObjectLocation[];
    workspaceId: string;
  },
): Promise<void> {
  const sorted = [...input.locations].sort((left, right) =>
    [left.storageProvider, left.storageBucket, left.storageKey]
      .join("\0")
      .localeCompare(
        [right.storageProvider, right.storageBucket, right.storageKey].join(
          "\0",
        ),
      ),
  );
  const seen = new Set<string>();
  for (const location of sorted) {
    const coordinate = [
      location.storageProvider,
      location.storageBucket,
      location.storageKey,
    ].join("\0");
    if (seen.has(coordinate)) {
      throw new JobExecutionError("cleanup_coordinate_conflict", "permanent");
    }
    seen.add(coordinate);
    await database.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          concat_ws(
            E'\\x1f',
            ${input.workspaceId}::text,
            ${location.storageProvider}::text,
            ${location.storageBucket}::text,
            ${location.storageKey}::text
          ),
          20260804
        )
      )
    `);
  }

  for (const location of sorted) {
    const conflictingFiles = await database
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.workspaceId, input.workspaceId),
          ne(files.id, input.fileId),
          isNull(files.deletedAt),
          eq(files.storageProvider, location.storageProvider),
          eq(files.storageBucket, location.storageBucket),
          eq(files.storageKey, location.storageKey),
        ),
      )
      .limit(1)
      .for("share");
    const conflictingVariants = await database
      .select({ id: fileVariants.id })
      .from(fileVariants)
      .innerJoin(
        files,
        and(
          eq(files.workspaceId, fileVariants.workspaceId),
          eq(files.id, fileVariants.parentFileId),
          isNull(files.deletedAt),
        ),
      )
      .where(
        and(
          eq(fileVariants.workspaceId, input.workspaceId),
          ne(fileVariants.parentFileId, input.fileId),
          eq(fileVariants.storageProvider, location.storageProvider),
          eq(fileVariants.storageBucket, location.storageBucket),
          eq(fileVariants.storageKey, location.storageKey),
        ),
      )
      .limit(1)
      .for("share", { of: [fileVariants, files] });
    if (conflictingFiles.length || conflictingVariants.length) {
      throw new JobExecutionError("cleanup_coordinate_conflict", "permanent");
    }
  }
}

function assertRuntimeStorageLocation(
  runtime: { storageBucket?: string; storageProvider?: string },
  locations: readonly FileObjectLocation[],
): void {
  if (!runtime.storageProvider || !runtime.storageBucket) {
    throw new JobExecutionError("storage_location_unconfigured", "permanent");
  }
  if (
    locations.some(
      (location) =>
        location.storageProvider !== runtime.storageProvider ||
        location.storageBucket !== runtime.storageBucket,
    )
  ) {
    throw new JobExecutionError("storage_location_mismatch", "permanent");
  }
}

function sameObjectLocations(
  left: readonly FileObjectLocation[],
  right: readonly FileObjectLocation[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (location, index) =>
        location.storageProvider === right[index]?.storageProvider &&
        location.storageBucket === right[index]?.storageBucket &&
        location.storageKey === right[index]?.storageKey,
    )
  );
}
