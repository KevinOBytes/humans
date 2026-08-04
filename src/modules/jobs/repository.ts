import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { newId } from "@/db/id";
import { imports as importsTable } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import type { Database } from "@/modules/auth/bootstrap-admin";

import type { JobKind } from "./types";

export type JobRow = typeof jobs.$inferSelect;

const MAX_DATABASE_LEASE_MS = 5 * 60_000;

function boundedDatabaseDuration(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_DATABASE_LEASE_MS
  ) {
    throw new TypeError("Invalid database duration");
  }
  return value;
}

export function createJobsRepository(database: Database) {
  return {
    async enqueue(input: {
      encryptedPayload: string;
      id: string;
      idempotencyKey: string;
      kind: JobKind;
      payloadHash: string;
      requestHash: string;
      priority?: number;
      scheduledAt?: Date;
      workspaceId: string;
      createdBy?: string | null;
    }): Promise<JobRow | null> {
      const [row] = await database
        .insert(jobs)
        .values({
          id: input.id,
          workspaceId: input.workspaceId,
          kind: input.kind,
          encryptedPayload: input.encryptedPayload,
          payloadHash: input.payloadHash,
          requestHash: input.requestHash,
          idempotencyKey: input.idempotencyKey,
          priority: input.priority ?? 0,
          state: "queued",
          scheduledAt: input.scheduledAt,
          createdBy: input.createdBy ?? null,
          updatedBy: input.createdBy ?? null,
        })
        .onConflictDoNothing({
          target: [jobs.workspaceId, jobs.kind, jobs.idempotencyKey],
        })
        .returning();
      return row ?? null;
    },

    async claimDue(input: {
      leaseDurationMs: number;
      leaseOwner: string;
      limit: number;
      now: Date;
    }): Promise<JobRow[]> {
      const leaseDurationMs = boundedDatabaseDuration(input.leaseDurationMs);
      return database.transaction(async (transaction) => {
        const candidates = await transaction
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            or(
              and(
                eq(jobs.state, "queued"),
                lte(jobs.scheduledAt, sql`clock_timestamp()`),
              ),
              and(
                eq(jobs.state, "running"),
                lt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
              ),
            ),
          )
          .orderBy(desc(jobs.priority), asc(jobs.scheduledAt), asc(jobs.id))
          .limit(input.limit)
          .for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        return transaction
          .update(jobs)
          .set({
            state: "running",
            attemptCount: sql`${jobs.attemptCount} + 1`,
            claimGeneration: sql`${jobs.claimGeneration} + 1`,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: sql<Date>`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`,
            updatedAt: input.now,
            updatedBy: null,
          })
          .where(
            inArray(
              jobs.id,
              candidates.map((candidate) => candidate.id),
            ),
          )
          .returning();
      });
    },

    async completeClaim(input: {
      claimGeneration: number;
      id: string;
      leaseOwner: string;
      now: Date;
      resultReferences?: readonly string[];
      workspaceId: string;
    }): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .update(jobs)
          .set({
            state: "completed",
            leaseOwner: null,
            leaseExpiresAt: null,
            errorCode: null,
            resultReferences: [...(input.resultReferences ?? [])],
            updatedAt: input.now,
            updatedBy: null,
          })
          .where(
            and(
              eq(jobs.id, input.id),
              eq(jobs.workspaceId, input.workspaceId),
              eq(jobs.state, "running"),
              eq(jobs.leaseOwner, input.leaseOwner),
              eq(jobs.claimGeneration, input.claimGeneration),
              gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ id: jobs.id });
        if (!row) return false;
        await transaction.insert(auditEvents).values({
          id: newId(),
          workspaceId: input.workspaceId,
          action: "job.complete",
          resourceKind: "job",
          resourceId: input.id,
          requestId: `worker:${input.leaseOwner}`,
          outcome: "success",
          redactedDiff: {
            resultReferenceCount: input.resultReferences?.length ?? 0,
            state: "completed",
          },
          actorUserId: null,
          sessionId: null,
          apiKeyId: null,
          occurredAt: input.now,
        });
        return true;
      });
    },

    async failClaim(input: {
      claimGeneration: number;
      errorCode: string;
      id: string;
      leaseOwner: string;
      now: Date;
      retryDelayMs: number | null;
      workspaceId: string;
    }): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const retryDelayMs =
          input.retryDelayMs === null
            ? null
            : boundedDatabaseDuration(input.retryDelayMs);
        const state = retryDelayMs === null ? "dead_letter" : "queued";
        const [row] = await transaction
          .update(jobs)
          .set({
            state,
            scheduledAt:
              retryDelayMs === null
                ? sql<Date>`clock_timestamp()`
                : sql<Date>`clock_timestamp() + (${retryDelayMs} * interval '1 millisecond')`,
            leaseOwner: null,
            leaseExpiresAt: null,
            errorCode: input.errorCode,
            updatedAt: input.now,
            updatedBy: null,
          })
          .where(
            and(
              eq(jobs.id, input.id),
              eq(jobs.workspaceId, input.workspaceId),
              eq(jobs.state, "running"),
              eq(jobs.leaseOwner, input.leaseOwner),
              eq(jobs.claimGeneration, input.claimGeneration),
              gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ id: jobs.id, kind: jobs.kind });
        if (!row) return false;
        if (retryDelayMs === null && row.kind === "import_execute") {
          const linkedImports = await transaction
            .select({ id: importsTable.id })
            .from(importsTable)
            .where(
              and(
                eq(importsTable.workspaceId, input.workspaceId),
                eq(importsTable.executionJobId, input.id),
                inArray(importsTable.state, ["queued", "running"]),
              ),
            )
            .limit(2)
            .for("update");
          const linkedImport = linkedImports[0];
          if (linkedImports.length === 1 && linkedImport) {
            const [failedImport] = await transaction
              .update(importsTable)
              .set({
                state: "dead_letter",
                completedAt: input.now,
                updatedAt: input.now,
                version: sql`${importsTable.version} + 1`,
              })
              .where(
                and(
                  eq(importsTable.workspaceId, input.workspaceId),
                  eq(importsTable.id, linkedImport.id),
                  eq(importsTable.executionJobId, input.id),
                  inArray(importsTable.state, ["queued", "running"]),
                ),
              )
              .returning({ id: importsTable.id });
            if (failedImport) {
              await transaction.insert(auditEvents).values({
                id: newId(),
                workspaceId: input.workspaceId,
                action: "import.dead_lettered",
                resourceKind: "import",
                resourceId: failedImport.id,
                requestId: `worker:${input.leaseOwner}`,
                outcome: "failure",
                redactedDiff: {
                  errorCode: input.errorCode,
                  jobId: input.id,
                  state: "dead_letter",
                },
                actorUserId: null,
                sessionId: null,
                apiKeyId: null,
                occurredAt: input.now,
              });
            }
          }
        }
        await transaction.insert(auditEvents).values({
          id: newId(),
          workspaceId: input.workspaceId,
          action: retryDelayMs === null ? "job.dead_letter" : "job.retry",
          resourceKind: "job",
          resourceId: input.id,
          requestId: `worker:${input.leaseOwner}`,
          outcome: retryDelayMs === null ? "dead_letter" : "failure",
          redactedDiff: { errorCode: input.errorCode, state },
          actorUserId: null,
          sessionId: null,
          apiKeyId: null,
          occurredAt: input.now,
        });
        return true;
      });
    },

    async deferClaim(input: {
      claimGeneration: number;
      errorCode?: string | null;
      id: string;
      leaseOwner: string;
      now: Date;
      retryDelayMs?: number;
      workspaceId: string;
    }): Promise<boolean> {
      const retryDelayMs = boundedDatabaseDuration(input.retryDelayMs ?? 1);
      const [row] = await database
        .update(jobs)
        .set({
          state: "queued",
          scheduledAt: sql<Date>`clock_timestamp() + (${retryDelayMs} * interval '1 millisecond')`,
          attemptCount: sql`greatest(${jobs.attemptCount} - 1, 0)`,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: input.errorCode ?? null,
          updatedAt: input.now,
          updatedBy: null,
        })
        .where(
          and(
            eq(jobs.id, input.id),
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.state, "running"),
            eq(jobs.leaseOwner, input.leaseOwner),
            eq(jobs.claimGeneration, input.claimGeneration),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: jobs.id });
      return Boolean(row);
    },

    async renewClaim(input: {
      claimGeneration: number;
      id: string;
      leaseDurationMs: number;
      leaseOwner: string;
      now: Date;
      workspaceId: string;
    }): Promise<boolean> {
      const leaseDurationMs = boundedDatabaseDuration(input.leaseDurationMs);
      const [row] = await database
        .update(jobs)
        .set({
          leaseExpiresAt: sql<Date>`clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond')`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(jobs.id, input.id),
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.state, "running"),
            eq(jobs.leaseOwner, input.leaseOwner),
            eq(jobs.claimGeneration, input.claimGeneration),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: jobs.id });
      return Boolean(row);
    },

    async getById(input: {
      id: string;
      workspaceId: string;
    }): Promise<JobRow | null> {
      const [row] = await database
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.id, input.id), eq(jobs.workspaceId, input.workspaceId)),
        )
        .limit(1);
      return row ?? null;
    },
    async lockById(input: {
      id: string;
      workspaceId: string;
    }): Promise<JobRow | null> {
      const [row] = await database
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.id, input.id), eq(jobs.workspaceId, input.workspaceId)),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getByIdempotency(input: {
      idempotencyKey: string;
      kind: JobKind;
      workspaceId: string;
    }): Promise<JobRow | null> {
      const [row] = await database
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.kind, input.kind),
            eq(jobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async lockByIdempotency(input: {
      idempotencyKey: string;
      kind: JobKind;
      workspaceId: string;
    }): Promise<JobRow | null> {
      const [row] = await database
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.kind, input.kind),
            eq(jobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async repairLegacyRequestHash(input: {
      id: string;
      payloadHash: string;
      requestHash: string;
      workspaceId: string;
    }): Promise<JobRow | null> {
      const [row] = await database
        .update(jobs)
        .set({
          requestHash: input.requestHash,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(jobs.id, input.id),
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.kind, "file_cleanup"),
            eq(jobs.payloadHash, input.payloadHash),
            isNull(jobs.requestHash),
          ),
        )
        .returning();
      return row ?? null;
    },
    async requeueTerminalCleanup(input: {
      id: string;
      scheduledAt: Date;
      workspaceId: string;
    }): Promise<JobRow | null> {
      return database.transaction(async (transaction) => {
        const [row] = await transaction
          .update(jobs)
          .set({
            attemptCount: 0,
            errorCode: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            resultReferences: [],
            scheduledAt: input.scheduledAt,
            state: "queued",
            updatedAt: sql`clock_timestamp()`,
            updatedBy: null,
          })
          .where(
            and(
              eq(jobs.id, input.id),
              eq(jobs.workspaceId, input.workspaceId),
              eq(jobs.kind, "file_cleanup"),
              inArray(jobs.state, ["completed", "dead_letter"]),
            ),
          )
          .returning();
        if (!row) return null;
        await transaction.insert(auditEvents).values({
          id: newId(),
          workspaceId: input.workspaceId,
          action: "job.cleanup_reconciled",
          resourceKind: "job",
          resourceId: input.id,
          requestId: "worker:cleanup-reconciler",
          outcome: "success",
          redactedDiff: { state: "queued" },
          actorUserId: null,
          sessionId: null,
          apiKeyId: null,
        });
        return row;
      });
    },
  };
}
