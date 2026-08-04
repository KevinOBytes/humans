import { randomUUID } from "node:crypto";

import type { RedisStore } from "@/lib/redis";
import { createJobLease } from "@/modules/jobs/lease";
import { createJobsService } from "@/modules/jobs/service";
import type { JobRow } from "@/modules/jobs/repository";
import {
  JOB_LEASE_MS,
  JobExecutionError,
  JobSliceDeferred,
  MAX_JOB_ATTEMPTS,
  MAX_RUN_ONCE_JOBS,
  MAX_RUN_ONCE_MS,
  isPermanentJobError,
  jobFailureCode,
  type JobPayload,
} from "@/modules/jobs/types";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { reconcileFileCleanupJobs } from "@/modules/files/cleanup";

import type { JobRegistry } from "./registry";

export type JobRunSummary = {
  claimed: number;
  completed: number;
  deadLettered: number;
  deferred: number;
};

function boundedRunOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError("Invalid bounded job runner option");
  }
  return result;
}

export function retryAt(input: {
  attempt: number;
  now: Date;
  random?: () => number;
}): Date {
  return new Date(input.now.getTime() + retryDelayMs(input));
}

export function retryDelayMs(input: {
  attempt: number;
  random?: () => number;
}): number {
  const random = input.random ?? Math.random;
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError("Invalid retry jitter");
  }
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, input.attempt - 1));
  return base + Math.floor(base * jitter);
}

function safeReferences(
  value: readonly string[] | undefined,
): readonly string[] {
  if (!value || value.length === 0) return [];
  if (
    value.length > 16 ||
    value.some(
      (reference) =>
        typeof reference !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          reference,
        ),
    )
  ) {
    throw new JobExecutionError("invalid_result_reference", "permanent");
  }
  return [...new Set(value.map((reference) => reference.toLowerCase()))];
}

export async function runJobsOnce(input: {
  database: Database;
  encryptionKey: string;
  limit?: number;
  now?: () => Date;
  random?: () => number;
  redis: RedisStore;
  registry: JobRegistry;
  signal?: AbortSignal;
  timeLimitMs?: number;
  workerId?: string;
}): Promise<JobRunSummary> {
  const limit = boundedRunOption(
    input.limit,
    MAX_RUN_ONCE_JOBS,
    MAX_RUN_ONCE_JOBS,
  );
  const timeLimitMs = boundedRunOption(
    input.timeLimitMs,
    MAX_RUN_ONCE_MS,
    MAX_RUN_ONCE_MS,
  );
  const now = input.now ?? (() => new Date());
  const workerId = input.workerId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/iu.test(workerId))
    throw new TypeError("Invalid job worker ID");

  const runController = new AbortController();
  const abortForDrain = () =>
    runController.abort(
      input.signal?.reason instanceof JobExecutionError
        ? input.signal.reason
        : new JobExecutionError("worker_draining", "retryable"),
    );
  if (input.signal?.aborted) abortForDrain();
  else input.signal?.addEventListener("abort", abortForDrain, { once: true });
  const deadline = setTimeout(
    () => runController.abort(new JobExecutionError("time_limit", "retryable")),
    timeLimitMs,
  );

  try {
    const service = createJobsService({
      database: input.database,
      encryptionKey: input.encryptionKey,
    });
    const startedAt = now().getTime();
    const emptySummary: JobRunSummary = {
      claimed: 0,
      completed: 0,
      deadLettered: 0,
      deferred: 0,
    };
    if (runController.signal.aborted) return emptySummary;
    await reconcileFileCleanupJobs({
      database: input.database,
      encryptionKey: input.encryptionKey,
    });
    if (runController.signal.aborted) return emptySummary;
    const claimed = await service.repository.claimDue({
      now: new Date(startedAt),
      limit,
      leaseOwner: workerId,
      leaseDurationMs: JOB_LEASE_MS,
    });
    const summary: JobRunSummary = {
      claimed: claimed.length,
      completed: 0,
      deadLettered: 0,
      deferred: 0,
    };

    for (const job of claimed) {
      if (
        runController.signal.aborted ||
        now().getTime() - startedAt >= timeLimitMs
      ) {
        const error = abortReason(runController.signal, "time_limit");
        await deferJob({
          job,
          repository: service.repository,
          workerId,
          now,
          random: input.random,
          errorCode: error.code,
        });
        summary.deferred += 1;
        continue;
      }
      const lease = createJobLease({
        jobId: job.id,
        owner: workerId,
        redis: input.redis,
      });
      let acquired = false;
      try {
        acquired = await lease.acquire();
      } catch {
        acquired = false;
      }
      if (!acquired) {
        await deferJob({
          job,
          repository: service.repository,
          workerId,
          now,
          random: input.random,
          errorCode: "lease_unavailable",
        });
        summary.deferred += 1;
        continue;
      }

      let payload: JobPayload | null = null;
      try {
        payload = service.decode(job);
        const handler = input.registry.get(payload);
        const renewLease = async (): Promise<boolean> => {
          if (runController.signal.aborted) return false;
          try {
            if (!(await lease.renew())) return false;
          } catch {
            return false;
          }
          const timestamp = now();
          return service.repository.renewClaim({
            claimGeneration: job.claimGeneration,
            id: job.id,
            workspaceId: job.workspaceId,
            leaseOwner: workerId,
            now: timestamp,
            leaseDurationMs: JOB_LEASE_MS,
          });
        };
        const result = await handler(payload, {
          job,
          renewLease,
          signal: runController.signal,
        });
        if (runController.signal.aborted) {
          throw abortReason(runController.signal, "worker_draining");
        }
        if (!(await renewLease())) {
          throw new JobExecutionError("lease_lost", "retryable");
        }
        const completed = await service.repository.completeClaim({
          claimGeneration: job.claimGeneration,
          id: job.id,
          workspaceId: job.workspaceId,
          leaseOwner: workerId,
          now: now(),
          resultReferences: safeReferences(result?.resultReferences),
        });
        if (completed) summary.completed += 1;
        else summary.deferred += 1;
      } catch (error) {
        if (runController.signal.aborted) {
          const aborted = abortReason(runController.signal, "worker_draining");
          const deferred = await service.repository.deferClaim({
            claimGeneration: job.claimGeneration,
            errorCode: aborted.code,
            id: job.id,
            workspaceId: job.workspaceId,
            leaseOwner: workerId,
            now: now(),
            retryDelayMs: retryDelayMs({
              attempt: job.attemptCount,
              random: input.random,
            }),
          });
          if (deferred) summary.deferred += 1;
          continue;
        }
        if (error instanceof JobSliceDeferred) {
          const deferred = await service.repository.deferClaim({
            claimGeneration: job.claimGeneration,
            id: job.id,
            workspaceId: job.workspaceId,
            leaseOwner: workerId,
            now: now(),
          });
          if (deferred) summary.deferred += 1;
          continue;
        }
        if (error instanceof JobExecutionError && error.code === "lease_lost") {
          const deferred = await service.repository.deferClaim({
            claimGeneration: job.claimGeneration,
            errorCode: error.code,
            id: job.id,
            workspaceId: job.workspaceId,
            leaseOwner: workerId,
            now: now(),
            retryDelayMs: retryDelayMs({
              attempt: job.attemptCount,
              random: input.random,
            }),
          });
          if (deferred) summary.deferred += 1;
          continue;
        }
        const permanent = isPermanentJobError(error);
        const deadLetter = permanent || job.attemptCount >= MAX_JOB_ATTEMPTS;
        const failed = await service.repository.failClaim({
          claimGeneration: job.claimGeneration,
          id: job.id,
          workspaceId: job.workspaceId,
          leaseOwner: workerId,
          now: now(),
          errorCode: jobFailureCode(error),
          retryDelayMs: deadLetter
            ? null
            : retryDelayMs({
                attempt: job.attemptCount,
                random: input.random,
              }),
        });
        if (failed && deadLetter) summary.deadLettered += 1;
        else if (failed) summary.deferred += 1;
      } finally {
        try {
          await lease.release();
        } catch {
          // PostgreSQL owns durable execution state; Redis cleanup is best effort.
        }
      }
    }
    return summary;
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", abortForDrain);
  }
}

function abortReason(
  signal: AbortSignal,
  fallback: "time_limit" | "worker_draining",
): JobExecutionError {
  return signal.reason instanceof JobExecutionError
    ? signal.reason
    : new JobExecutionError(fallback, "retryable");
}

async function deferJob(input: {
  errorCode: string;
  job: JobRow;
  now: () => Date;
  random?: () => number;
  repository: ReturnType<typeof createJobsService>["repository"];
  workerId: string;
}): Promise<void> {
  const timestamp = input.now();
  await input.repository.deferClaim({
    claimGeneration: input.job.claimGeneration,
    id: input.job.id,
    workspaceId: input.job.workspaceId,
    leaseOwner: input.workerId,
    now: timestamp,
    errorCode: input.errorCode,
    retryDelayMs: retryDelayMs({
      attempt: input.job.attemptCount,
      random: input.random,
    }),
  });
}
