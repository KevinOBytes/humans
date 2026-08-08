// @vitest-environment node

import IORedis from "ioredis";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { newId } from "@/db/id";
import { auditEvents, jobs } from "@/db/schema/operations";
import { organizations } from "@/db/schema/auth";
import { workspaces } from "@/db/schema/workspaces";
import { LocalRedisStore } from "@/lib/redis";
import { createJobsService } from "@/modules/jobs/service";
import { runJobsOnce } from "@/worker/run-once";
import { createJobRegistry } from "@/worker/registry";
import { runJobsContinuously } from "@/worker/run-continuous";

import {
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
  type TestDatabase,
} from "../support/auth";

const liveDescribe =
  process.env.TEST_DATABASE_URL && process.env.REDIS_TEST_URL
    ? describe
    : describe.skip;
const encryptionKey = "42".repeat(32);

liveDescribe("whole-application dependency failure evidence", () => {
  let connection: ReturnType<typeof createTestConnection>;
  let database: TestDatabase;

  beforeAll(async () => {
    connection = createTestConnection();
    database = createTestDatabase(connection);
  });

  beforeEach(async () => resetTestDatabase(connection));

  afterAll(async () => {
    await connection.end({ timeout: 5 });
  });

  async function seedWorkspace(): Promise<string> {
    const organizationId = `org-${newId()}`;
    const workspaceId = newId();
    await database.insert(organizations).values({
      id: organizationId,
      name: `Failure ${workspaceId}`,
      slug: `failure-${workspaceId}`,
      createdAt: new Date(),
    });
    await database.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: `Failure ${workspaceId}`,
      createdBy: "system",
      updatedBy: "system",
    });
    return workspaceId;
  }

  function registry(handler: () => Promise<never>) {
    return createJobRegistry({
      aiExecute: async () => undefined,
      importExecute: handler,
      fileCleanup: async () => undefined,
    });
  }

  async function connectRedis() {
    const client = new IORedis(process.env.REDIS_TEST_URL!, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await client.ping();
    return client;
  }

  it("backs off after a real PostgreSQL outage without claiming work succeeded", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: `postgres-outage-${newId()}`,
      payload: { kind: "import_execute", importId: workspaceId },
    });
    const brokenConnection = createTestConnection(1);
    const brokenDatabase = createTestDatabase(brokenConnection);
    await brokenConnection.end({ timeout: 5 });
    const redisClient = await connectRedis();
    const controller = new AbortController();
    const waits: number[] = [];
    let attempts = 0;

    try {
      await expect(
        runJobsContinuously({
          runOnce: async () => {
            attempts += 1;
            return runJobsOnce({
              database: brokenDatabase,
              encryptionKey,
              redis: new LocalRedisStore(redisClient),
              registry: registry(async () => {
                throw new Error(
                  "handler must not run while PostgreSQL is down",
                );
              }),
            });
          },
          signal: controller.signal,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
            if (waits.length >= 2) controller.abort();
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await redisClient.quit();
    }

    expect(attempts).toBe(2);
    expect(waits).toEqual([1_000, 2_000]);
    await expect(
      service.repository.getById({ id: job.id, workspaceId }),
    ).resolves.toMatchObject({
      state: "queued",
      attemptCount: 0,
      claimGeneration: 0,
      leaseOwner: null,
      errorCode: null,
    });
  });

  it("defers a claimed job when a real Redis outage prevents leasing", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: `redis-outage-${newId()}`,
      payload: { kind: "import_execute", importId: workspaceId },
    });
    const redisClient = await connectRedis();
    redisClient.disconnect();
    const handler = vi.fn(async () => undefined);

    const result = await runJobsOnce({
      database,
      encryptionKey,
      redis: new LocalRedisStore(redisClient),
      registry: createJobRegistry({
        aiExecute: async () => undefined,
        importExecute: handler,
        fileCleanup: async () => undefined,
      }),
      random: () => 0,
    });

    expect(result).toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
    expect(handler).not.toHaveBeenCalled();
    await expect(
      service.repository.getById({ id: job.id, workspaceId }),
    ).resolves.toMatchObject({
      state: "queued",
      attemptCount: 0,
      claimGeneration: 1,
      errorCode: "lease_unavailable",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("dead-letters the fifth transient attempt with real Redis leasing and redacted audit", async () => {
    const workspaceId = await seedWorkspace();
    const service = createJobsService({ database, encryptionKey });
    const job = await service.enqueue({
      workspaceId,
      idempotencyKey: `redis-exhaustion-${newId()}`,
      payload: { kind: "import_execute", importId: workspaceId },
    });
    await database
      .update(jobs)
      .set({ attemptCount: 4 })
      .where(eq(jobs.id, job.id));
    const redisClient = await connectRedis();

    try {
      const result = await runJobsOnce({
        database,
        encryptionKey,
        redis: new LocalRedisStore(redisClient),
        registry: registry(async () => {
          throw new Error("provider secret must not be persisted");
        }),
        random: () => 0,
      });

      expect(result).toMatchObject({
        claimed: 1,
        completed: 0,
        deadLettered: 1,
      });
    } finally {
      await redisClient.quit();
    }

    await expect(
      service.repository.getById({ id: job.id, workspaceId }),
    ).resolves.toMatchObject({
      state: "dead_letter",
      attemptCount: 5,
      errorCode: "dependency_unavailable",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const storedAudit = await database
      .select({
        action: auditEvents.action,
        outcome: auditEvents.outcome,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          eq(auditEvents.resourceId, job.id),
        ),
      );
    expect(storedAudit).toHaveLength(1);
    expect(storedAudit[0]).toMatchObject({
      action: "job.dead_letter",
      outcome: "dead_letter",
      redactedDiff: {
        errorCode: "dependency_unavailable",
        state: "dead_letter",
      },
    });
    expect(JSON.stringify(storedAudit)).not.toContain("provider secret");
  });
});
