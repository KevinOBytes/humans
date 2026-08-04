import type { ServerEnv } from "@/lib/env/server-schema";
import { createEmailSender } from "@/lib/email/resend";
import { createRedisStore } from "@/lib/redis";
import { createObjectStore } from "@/lib/storage/s3";
import type { ObjectStore } from "@/lib/storage/types";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  cleanupAuthEmailOutbox,
  runAuthEmailOutboxOnce,
} from "@/modules/auth/email-outbox";
import { createFileCleanupService } from "@/modules/files/cleanup";
import { createFileCleanupHandler } from "@/worker/handlers/storage-cleanup";
import {
  createImportExecuteHandler,
  createImportExecuteService,
} from "@/worker/handlers/import";
import { createJobRegistry } from "@/worker/registry";
import { runJobsOnce } from "@/worker/run-once";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import {
  createTask12Metrics,
  productionMetricsSink,
} from "@/modules/search/metrics";

export function createRuntimeJobRegistry(input: {
  database: Database;
  encryptionKey: string;
  objectStore: ObjectStore;
  searchIndexMaintenance: SearchIndexMaintenance;
}) {
  return createJobRegistry({
    importExecute: createImportExecuteHandler(
      createImportExecuteService({
        database: input.database,
        encryptionKey: input.encryptionKey,
        searchIndexMaintenance: input.searchIndexMaintenance,
      }),
    ),
    fileCleanup: createFileCleanupHandler(
      createFileCleanupService({
        database: input.database,
        objectStore: input.objectStore,
      }),
    ),
  });
}

export function createRuntimeJobRunner(input: {
  database: Database;
  env: ServerEnv;
}) {
  const redis = createRedisStore(input.env);
  const registry = createRuntimeJobRegistry({
    database: input.database,
    encryptionKey: input.env.DATA_ENCRYPTION_KEY,
    objectStore: createObjectStore(input.env),
    searchIndexMaintenance: createSearchIndexMaintenance({
      metrics: createTask12Metrics(productionMetricsSink),
    }),
  });
  const emailSender = createEmailSender(input.env);
  return async (options: { signal?: AbortSignal } = {}) => {
    if (!options.signal?.aborted) {
      await cleanupAuthEmailOutbox({ database: input.database });
    }
    const authEmailSummary = options.signal?.aborted
      ? { claimed: 0, completed: 0, deadLettered: 0, deferred: 0 }
      : await runAuthEmailOutboxOnce({
          database: input.database,
          emailSender,
          encryptionKey: input.env.AUTH_ENCRYPTION_KEY,
          limit: 1,
        });
    const jobSummary = await runJobsOnce({
      database: input.database,
      encryptionKey: input.env.DATA_ENCRYPTION_KEY,
      redis,
      registry,
      signal: options.signal,
    });
    return {
      claimed: authEmailSummary.claimed + jobSummary.claimed,
      completed: authEmailSummary.completed + jobSummary.completed,
      deadLettered: authEmailSummary.deadLettered + jobSummary.deadLettered,
      deferred: authEmailSummary.deferred + jobSummary.deferred,
    };
  };
}
