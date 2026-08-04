import { isNull } from "drizzle-orm";

import { databaseConnection, db } from "@/db/client";
import { newId } from "@/db/id";
import { workspaces } from "@/db/schema/workspaces";
import { getServerEnv } from "@/lib/env/server";
import { createRedisStore } from "@/lib/redis";
import { createJobsService } from "@/modules/jobs/service";
import { createJobRegistry } from "@/worker/registry";
import { createWorkerHeartbeat } from "@/worker/heartbeat";
import { runJobsContinuously } from "@/worker/run-continuous";
import { runJobsOnce } from "@/worker/run-once";

async function main(): Promise<void> {
  const idempotencyKey = process.env.WORKER_DRAIN_IDEMPOTENCY_KEY;
  if (!idempotencyKey) throw new Error("Missing worker drain idempotency key");

  const env = getServerEnv();
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(isNull(workspaces.deletedAt))
    .limit(1);
  if (!workspace) throw new Error("Worker drain fixture requires a workspace");

  await createJobsService({
    database: db,
    encryptionKey: env.DATA_ENCRYPTION_KEY,
  }).enqueue({
    idempotencyKey,
    payload: { kind: "file_cleanup", uploadSessionId: newId() },
    workspaceId: workspace.id,
  });

  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const registry = createJobRegistry({
    importExecute: async () => undefined,
    fileCleanup: async (_payload, context) => {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve();
          return;
        }
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
  });
  const redis = createRedisStore(env);

  try {
    await runJobsContinuously({
      heartbeat: createWorkerHeartbeat(),
      runOnce: ({ signal }) =>
        runJobsOnce({
          database: db,
          encryptionKey: env.DATA_ENCRYPTION_KEY,
          redis,
          registry,
          signal,
        }),
      signal: controller.signal,
    });
  } finally {
    await databaseConnection.end({ timeout: 5 });
  }
}

void main().then(
  () => process.exit(0),
  () => process.exit(1),
);
