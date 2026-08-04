import type { ServerEnv } from "@/lib/env/server-schema";
import { createEmailSender } from "@/lib/email/resend";
import { createRedisStore } from "@/lib/redis";
import { createObjectStore } from "@/lib/storage/s3";
import type { ObjectStore } from "@/lib/storage/types";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { OperationLimiter } from "@/graphql/operation-limiter";
import { createAiProvider, AiProviderError } from "@/modules/ai/provider";
import { createResearchTools } from "@/modules/ai/tools";
import { createEvidenceService } from "@/modules/evidence/service";
import {
  cleanupAuthEmailOutbox,
  runAuthEmailOutboxOnce,
} from "@/modules/auth/email-outbox";
import { createFileCleanupService } from "@/modules/files/cleanup";
import { createGraphService } from "@/modules/graph/service";
import { createPeopleService } from "@/modules/people/service";
import { createSearchService } from "@/modules/search/service";
import { createFileCleanupHandler } from "@/worker/handlers/storage-cleanup";
import {
  createAiAnalysisHandler,
  type AiAnalysisHandlerRuntime,
} from "@/worker/handlers/ai-analysis";
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
  ai?: Pick<AiAnalysisHandlerRuntime, "createTools" | "hmacKey" | "provider">;
  database: Database;
  encryptionKey: string;
  objectStore: ObjectStore;
  searchIndexMaintenance: SearchIndexMaintenance;
  storageBucket?: string;
  storageProvider?: string;
}) {
  const unavailableProvider = Object.freeze({
    disclosure: Object.freeze({
      model: "unconfigured",
      provider: "COMPATIBLE" as const,
    }),
    baseUrlFingerprint: "0".repeat(64),
    async generate(): Promise<never> {
      throw new AiProviderError("CONFIGURATION_INVALID");
    },
  });
  return createJobRegistry({
    aiExecute: createAiAnalysisHandler({
      database: input.database,
      encryptionKey: input.encryptionKey,
      hmacKey: input.ai?.hmacKey ?? input.encryptionKey,
      provider: input.ai?.provider ?? unavailableProvider,
      createTools:
        input.ai?.createTools ??
        (({ run }) =>
          createResearchTools({
            scope: run.scope,
            people: { get: async () => null },
            evidence: { getEvidence: async () => null },
            search: { search: async () => ({ nodes: [] }) },
            graph: { query: async () => ({ nodes: [], edges: [] }) },
          })),
    }),
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
        storageBucket: input.storageBucket,
        storageProvider: input.storageProvider,
      }),
    ),
  });
}

export function createRuntimeJobRunner(input: {
  database: Database;
  env: ServerEnv;
}) {
  const redis = createRedisStore(input.env);
  const metrics = createTask12Metrics(productionMetricsSink);
  const searchIndexMaintenance = createSearchIndexMaintenance({ metrics });
  const operationLimiter = new OperationLimiter(
    redis,
    undefined,
    input.env.OPERATION_LIMIT_HMAC_KEY,
  );
  const provider = createAiProvider({
    provider: input.env.AI_PROVIDER,
    baseUrl: input.env.AI_BASE_URL,
    apiKey: input.env.AI_API_KEY,
    model: input.env.AI_MODEL,
    fingerprintHmacKey: input.env.DATA_ENCRYPTION_KEY,
    nodeEnv: input.env.NODE_ENV,
  });
  const registry = createRuntimeJobRegistry({
    ai: {
      hmacKey: input.env.DATA_ENCRYPTION_KEY,
      provider,
      createTools: ({ authority, run }) => {
        const requestId = `worker:ai:${run.threadId}`;
        const researchContext = {
          actor: authority.actor,
          database: input.database,
          permissions: authority.permissions,
          requestId,
          searchIndexMaintenance,
          workspaceId: authority.workspaceId,
        };
        const requestOperationLimiter = operationLimiter.forRequest({
          actor: authority.actor,
          clientAddress: { reason: "disabled", trust: "unknown" },
          requestId,
          workspaceId: authority.workspaceId,
        });
        const serviceContext = {
          ...researchContext,
          cursorHmacKey: input.env.PROTECTED_LOOKUP_HMAC_KEY,
          metrics,
          operationLimiter: requestOperationLimiter,
        };
        return createResearchTools({
          scope: run.scope,
          people: createPeopleService(researchContext),
          evidence: createEvidenceService(researchContext),
          search: createSearchService(serviceContext, {
            cursorHmacKey: input.env.PROTECTED_LOOKUP_HMAC_KEY,
            encryptionKey: input.env.DATA_ENCRYPTION_KEY,
            protectedLookupHmacKey: input.env.PROTECTED_LOOKUP_HMAC_KEY,
          }),
          graph: createGraphService(serviceContext),
        });
      },
    },
    database: input.database,
    encryptionKey: input.env.DATA_ENCRYPTION_KEY,
    objectStore: createObjectStore(input.env),
    searchIndexMaintenance,
    storageBucket: input.env.STORAGE_BUCKET,
    storageProvider: input.env.STORAGE_PROVIDER,
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
