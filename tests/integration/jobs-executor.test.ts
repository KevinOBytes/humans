// @vitest-environment node

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { organizations } from "@/db/schema/auth";
import { auditEvents, jobs } from "@/db/schema/operations";
import { workspacePrincipals } from "@/db/schema/principals";
import { workspaces } from "@/db/schema/workspaces";
import { createJobsService } from "@/modules/jobs/service";
import { JobExecutionError } from "@/modules/jobs/types";
import type { RedisStore } from "@/lib/redis";
import { jobLeaseKey } from "@/modules/jobs/lease";
import { createJobRegistry } from "@/worker/registry";
import { runJobsOnce } from "@/worker/run-once";

import {
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
  type TestDatabase,
} from "../support/auth";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const encryptionKey = "42".repeat(32);

class MemoryRedis implements RedisStore {
  private readonly leases = new Map<string, string>();

  hasLease(key: string): boolean {
    return this.leases.has(key);
  }

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  increment(): Promise<number> {
    return Promise.resolve(1);
  }

  acquireLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    void ttlMs;
    if (this.leases.has(key)) return Promise.resolve(false);
    this.leases.set(key, token);
    return Promise.resolve(true);
  }

  extendLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    void ttlMs;
    return Promise.resolve(this.leases.get(key) === token);
  }

  releaseLease(key: string, token: string): Promise<boolean> {
    if (this.leases.get(key) !== token) return Promise.resolve(false);
    this.leases.delete(key);
    return Promise.resolve(true);
  }

  consumeTokenBucket(): Promise<{
    allowed: boolean;
    remainingMicrotokens: number;
    retryAfterMs: number;
  }> {
    return Promise.resolve({
      allowed: true,
      remainingMicrotokens: 0,
      retryAfterMs: 0,
    });
  }
}

class FailingRedis extends MemoryRedis {
  constructor(private readonly phase: "acquire" | "renew" | "release") {
    super();
  }

  override acquireLease(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (this.phase === "acquire") return Promise.reject(new Error("redis"));
    return super.acquireLease(key, token, ttlMs);
  }

  override extendLease(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (this.phase === "renew") return Promise.reject(new Error("redis"));
    return super.extendLease(key, token, ttlMs);
  }

  override releaseLease(key: string, token: string): Promise<boolean> {
    if (this.phase === "release") return Promise.reject(new Error("redis"));
    return super.releaseLease(key, token);
  }
}

liveDescribe("durable PostgreSQL job executor", () => {
  let connection: ReturnType<typeof createTestConnection>;
  let database: TestDatabase;

  beforeAll(async () => {
    connection = createTestConnection();
    database = createTestDatabase(connection);
  });
  beforeEach(async () => resetTestDatabase(connection));
  afterAll(async () => connection.end({ timeout: 5 }));

  async function seedWorkspace(): Promise<string> {
    const organizationId = `org-${newId()}`;
    const id = newId();
    await database.insert(organizations).values({
      id: organizationId,
      name: `Jobs ${id}`,
      slug: `jobs-${id}`,
      createdAt: new Date(),
    });
    await database.insert(workspaces).values({
      id,
      organizationId,
      name: `Jobs ${id}`,
      createdBy: "system",
      updatedBy: "system",
    });
    return id;
  }

  async function seedSystemPrincipal(workspaceId: string): Promise<string> {
    const principalId = newId();
    await database.insert(workspacePrincipals).values({
      id: principalId,
      principalType: "system",
      systemKey: `jobs-test-${principalId}`,
      workspaceId,
    });
    return principalId;
  }

  it("enqueues and executes principal-attributed AI jobs through the existing executor", async () => {
    const workspaceId = await seedWorkspace();
    const principalId = await seedSystemPrincipal(workspaceId);
    const service = createJobsService({ database, encryptionKey });
    const aiHandler = vi.fn(async () => ({ resultReferences: [workspaceId] }));
    const job = await service.enqueue({
      workspaceId,
      principalId,
      idempotencyKey: "ai-principal",
      payload: { kind: "ai_execute", runId: newId() },
    });

    await expect(
      service.enqueue({
        workspaceId,
        createdBy: "legacy-user",
        principalId,
        idempotencyKey: "ai-conflicting-principals",
        payload: { kind: "ai_execute", runId: newId() },
      }),
    ).rejects.toThrow("Invalid durable job attribution");

    await expect(
      runJobsOnce({
        database,
        encryptionKey,
        redis: new MemoryRedis(),
        registry: createJobRegistry({
          aiExecute: aiHandler,
          importExecute: async () => undefined,
          fileCleanup: async () => undefined,
        }),
        workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96cf0",
      }),
    ).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(aiHandler).toHaveBeenCalledOnce();
    expect(
      await service.repository.getById({ id: job.id, workspaceId }),
    ).toMatchObject({
      principalId,
      createdBy: null,
      state: "completed",
    });
  });

  it("claims a durable job once, requires the Redis owner, and records system completion", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: "import-once",
      payload: { kind: "import_execute", importId: workspaceId },
    });
    const handler = vi.fn(async () => ({ resultReferences: [workspaceId] }));
    const registry = createJobRegistry({
      aiExecute: async () => undefined,
      importExecute: handler,
      fileCleanup: async () => undefined,
    });
    const redis = new MemoryRedis();

    const [first, second] = await Promise.all([
      runJobsOnce({
        database,
        encryptionKey,
        redis,
        registry,
        workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf3",
      }),
      runJobsOnce({
        database,
        encryptionKey,
        redis,
        registry,
        workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf4",
      }),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const stored = await service.repository.getById({
      id: job.id,
      workspaceId,
    });
    expect(stored).toMatchObject({
      state: "completed",
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
    });
    const [audit] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          eq(auditEvents.resourceId, job.id),
        ),
      );
    expect(audit).toMatchObject({
      action: "job.complete",
      outcome: "success",
      actorUserId: null,
      sessionId: null,
      apiKeyId: null,
    });
  });

  it("fences and defers active and prefetched jobs when the pass deadline expires", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const active = await service.enqueue({
      workspaceId,
      idempotencyKey: "deadline-active",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
    });
    const prefetched = await service.enqueue({
      workspaceId,
      idempotencyKey: "deadline-prefetched",
      payload: { kind: "file_cleanup", uploadSessionId: newId() },
    });
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn(
      async (_payload, context: { signal: AbortSignal }) => {
        handlerSignal = context.signal;
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      },
    );
    const started = Date.now();

    const result = await runJobsOnce({
      database,
      encryptionKey,
      redis: new MemoryRedis(),
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: async () => undefined,
        fileCleanup: handler,
      }),
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96df0",
      random: () => 0,
      timeLimitMs: 100,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ claimed: 2, completed: 0, deferred: 2 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handlerSignal?.aborted).toBe(true);
    for (const job of [active, prefetched]) {
      expect(
        await service.repository.getById({ id: job.id, workspaceId }),
      ).toMatchObject({
        state: "queued",
        attemptCount: 0,
        errorCode: "time_limit",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
  });

  it("retains PostgreSQL and Redis ownership until a non-cooperative handler settles", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const active = await service.enqueue({
      workspaceId,
      idempotencyKey: "drain-non-cooperative-active",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
    });
    const prefetched = await service.enqueue({
      workspaceId,
      idempotencyKey: "drain-non-cooperative-prefetched",
      payload: { kind: "file_cleanup", uploadSessionId: newId() },
    });
    const controller = new AbortController();
    const redis = new MemoryRedis();
    let handlerSignal: AbortSignal | undefined;
    let settleHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      settleHandler = resolve;
    });
    const handler = vi.fn(
      async (_payload, context: { signal: AbortSignal }) => {
        handlerSignal = context.signal;
        await handlerGate;
      },
    );
    let runnerSettled = false;

    const running = runJobsOnce({
      database,
      encryptionKey,
      redis,
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: async () => undefined,
        fileCleanup: handler,
      }),
      signal: controller.signal,
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96df1",
      random: () => 0,
    }).finally(() => {
      runnerSettled = true;
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    controller.abort();
    await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
    await Promise.resolve();
    expect(runnerSettled).toBe(false);
    expect(redis.hasLease(jobLeaseKey(active.id))).toBe(true);
    expect(
      await service.repository.getById({ id: active.id, workspaceId }),
    ).toMatchObject({
      state: "running",
      attemptCount: 1,
      claimGeneration: 1,
      leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96df1",
    });
    expect(
      await service.repository.getById({ id: prefetched.id, workspaceId }),
    ).toMatchObject({
      state: "running",
      attemptCount: 1,
      claimGeneration: 1,
      leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96df1",
    });
    await expect(
      service.repository.claimDue({
        now: new Date(),
        limit: 2,
        leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96df2",
        leaseDurationMs: 60_000,
      }),
    ).resolves.toEqual([]);
    await expect(
      service.repository.completeClaim({
        claimGeneration: 1,
        id: active.id,
        workspaceId,
        leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96df2",
        now: new Date(),
      }),
    ).resolves.toBe(false);

    settleHandler();
    await expect(running).resolves.toMatchObject({
      claimed: 2,
      completed: 0,
      deferred: 2,
    });
    expect(redis.hasLease(jobLeaseKey(active.id))).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    for (const job of [active, prefetched]) {
      expect(
        await service.repository.getById({ id: job.id, workspaceId }),
      ).toMatchObject({
        state: "queued",
        attemptCount: 0,
        errorCode: "worker_draining",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
  });

  it("backs off transient failures and dead-letters permanent failures without handler text", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const retry = await service.enqueue({
      workspaceId,
      idempotencyKey: "retry",
      payload: { kind: "import_execute", importId: workspaceId },
    });
    const permanent = await service.enqueue({
      workspaceId,
      idempotencyKey: "dead-letter",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
    });
    const before = new Date();
    await runJobsOnce({
      database,
      encryptionKey,
      redis: new MemoryRedis(),
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf5",
      now: () => new Date("2100-01-01T00:00:00.000Z"),
      random: () => 0,
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: async () => {
          throw new Error("provider credentials must not be persisted");
        },
        fileCleanup: async () => {
          throw new JobExecutionError("validation_failed", "permanent");
        },
      }),
    });

    const retryStored = await service.repository.getById({
      id: retry.id,
      workspaceId,
    });
    const permanentStored = await service.repository.getById({
      id: permanent.id,
      workspaceId,
    });
    expect(retryStored).toMatchObject({
      state: "queued",
      attemptCount: 1,
      errorCode: "dependency_unavailable",
      leaseOwner: null,
    });
    expect(retryStored?.scheduledAt.getTime()).toBeGreaterThan(
      before.getTime(),
    );
    expect(retryStored?.scheduledAt.getTime()).toBeLessThan(
      Date.now() + 10_000,
    );
    expect(permanentStored).toMatchObject({
      state: "dead_letter",
      attemptCount: 1,
      errorCode: "validation_failed",
      leaseOwner: null,
    });
    const storedAudit = await database
      .select({ redactedDiff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, retry.id));
    expect(JSON.stringify(storedAudit)).not.toContain("provider credentials");
  });

  it("does not run a PostgreSQL claim whose Redis lease belongs to another worker", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: "lease-owner",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
    });
    const redis = new MemoryRedis();
    await redis.acquireLease(jobLeaseKey(job.id), "other-worker", 60_000);
    const handler = vi.fn(async () => undefined);

    const result = await runJobsOnce({
      database,
      encryptionKey,
      redis,
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: async () => undefined,
        fileCleanup: handler,
      }),
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf6",
      random: () => 0,
    });

    expect(result).toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(
      await service.repository.getById({ id: job.id, workspaceId }),
    ).toMatchObject({
      state: "queued",
      attemptCount: 0,
      errorCode: "lease_unavailable",
      leaseOwner: null,
    });
  });

  it.each(["acquire", "renew", "release"] as const)(
    "isolates a Redis %s failure without exhausting handler attempts",
    async (phase) => {
      const workspaceId = await seedWorkspace();
      const service = createJobsService({ database, encryptionKey });
      const job = await service.enqueue({
        workspaceId,
        idempotencyKey: `redis-${phase}`,
        payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
      });
      const handler = vi.fn(async () => undefined);

      await expect(
        runJobsOnce({
          database,
          encryptionKey,
          redis: new FailingRedis(phase),
          registry: createJobRegistry({
            aiExecute: async () => undefined,
            importExecute: async () => undefined,
            fileCleanup: handler,
          }),
          workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96c00",
          random: () => 0,
        }),
      ).resolves.toMatchObject({
        claimed: 1,
        completed: phase === "release" ? 1 : 0,
        deferred: phase === "release" ? 0 : 1,
      });

      expect(
        await service.repository.getById({ id: job.id, workspaceId }),
      ).toMatchObject({
        state: phase === "release" ? "completed" : "queued",
        attemptCount: phase === "release" ? 1 : 0,
      });
      expect(handler).toHaveBeenCalledTimes(phase === "acquire" ? 0 : 1);
    },
  );

  it("uses the PostgreSQL clock for stale claims and live completion guards", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: "database-lease-clock",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
    });
    await database
      .update(jobs)
      .set({
        state: "running",
        attemptCount: 1,
        claimGeneration: 1,
        leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd1",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(jobs.id, job.id));

    const [reclaimed] = await service.repository.claimDue({
      now: new Date("2000-01-01T00:00:00.000Z"),
      limit: 1,
      leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd2",
      leaseDurationMs: 60_000,
    });
    expect(reclaimed).toMatchObject({
      id: job.id,
      claimGeneration: 2,
      leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd2",
    });
    expect(reclaimed?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(reclaimed?.leaseExpiresAt?.getTime()).toBeLessThan(
      Date.now() + 90_000,
    );
    await expect(
      service.repository.renewClaim({
        claimGeneration: 2,
        id: job.id,
        workspaceId,
        leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd2",
        now: new Date("2100-01-01T00:00:00.000Z"),
        leaseDurationMs: 60_000,
      }),
    ).resolves.toBe(true);
    const renewed = await service.repository.getById({
      id: job.id,
      workspaceId,
    });
    expect(renewed?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(renewed?.leaseExpiresAt?.getTime()).toBeLessThan(
      Date.now() + 90_000,
    );
    await expect(
      service.repository.completeClaim({
        claimGeneration: 2,
        id: job.id,
        workspaceId,
        leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd2",
        now: new Date("2100-01-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(true);

    const queued = await service.enqueue({
      workspaceId,
      idempotencyKey: "database-due-clock",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
      scheduledAt: new Date(Date.now() - 1_000),
    });
    const [claimedFromBehindClock] = await service.repository.claimDue({
      now: new Date("2000-01-01T00:00:00.000Z"),
      limit: 1,
      leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd3",
      leaseDurationMs: 60_000,
    });
    expect(claimedFromBehindClock).toMatchObject({
      id: queued.id,
      claimGeneration: 1,
      leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd3",
    });
    expect(claimedFromBehindClock?.leaseExpiresAt?.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(claimedFromBehindClock?.leaseExpiresAt?.getTime()).toBeLessThan(
      Date.now() + 90_000,
    );
    await expect(
      service.repository.failClaim({
        claimGeneration: 1,
        id: queued.id,
        workspaceId,
        leaseOwner: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bd3",
        now: new Date("2000-01-01T00:00:00.000Z"),
        errorCode: "dependency_unavailable",
        retryDelayMs: 1_000,
      }),
    ).resolves.toBe(true);
    const retriedFromBehindClock = await service.repository.getById({
      id: queued.id,
      workspaceId,
    });
    expect(retriedFromBehindClock?.scheduledAt.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(retriedFromBehindClock?.scheduledAt.getTime()).toBeLessThan(
      Date.now() + 10_000,
    );
  });

  it("dead-letters the fifth transient attempt", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: "maximum-attempts",
      payload: { kind: "import_execute", importId: workspaceId },
    });
    await database
      .update(jobs)
      .set({ attemptCount: 4 })
      .where(eq(jobs.id, job.id));

    await runJobsOnce({
      database,
      encryptionKey,
      redis: new MemoryRedis(),
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: async () => {
          throw new Error("transient service outage");
        },
        fileCleanup: async () => undefined,
      }),
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf7",
    });

    expect(
      await service.repository.getById({ id: job.id, workspaceId }),
    ).toMatchObject({
      state: "dead_letter",
      attemptCount: 5,
      errorCode: "dependency_unavailable",
      leaseOwner: null,
    });
  });

  it("does not consume an attempt when the bounded runner defers for time", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: "time-limit-deferral",
      payload: { kind: "file_cleanup", uploadSessionId: workspaceId },
    });
    await database
      .update(jobs)
      .set({ attemptCount: 4 })
      .where(eq(jobs.id, job.id));
    let clock = 0;
    const handler = vi.fn(async () => undefined);

    await runJobsOnce({
      database,
      encryptionKey,
      redis: new MemoryRedis(),
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: async () => undefined,
        fileCleanup: handler,
      }),
      workerId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96c01",
      timeLimitMs: 1_000,
      now: () => new Date(clock++ * 2_000),
      random: () => 0,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(
      await service.repository.getById({ id: job.id, workspaceId }),
    ).toMatchObject({
      state: "queued",
      attemptCount: 4,
      errorCode: "time_limit",
    });
  });
});
