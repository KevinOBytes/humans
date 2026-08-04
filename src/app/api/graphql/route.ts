import {
  createGraphQLInternalErrorResponse,
  createGraphQLRequestId,
} from "@/graphql/server";
import { OperationLimiter } from "@/graphql/operation-limiter";
import { productionSecurityEventLogger } from "@/lib/observability/security-events";
import { createSearchIndexMaintenance } from "@/modules/search/indexer";
import {
  createTask12Metrics,
  productionMetricsSink,
} from "@/modules/search/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let productionHandler:
  | Promise<(request: Request, requestId?: string) => Promise<Response>>
  | undefined;

async function getProductionHandler() {
  productionHandler ??= Promise.all([
    import("@/db/client"),
    import("@/graphql/server"),
    import("@/lib/env/server"),
    import("@/lib/redis"),
    import("@/lib/storage/s3"),
    import("@/modules/auth/auth"),
    import("@/lib/email/resend"),
  ]).then(
    ([
      { db },
      { createGraphQLHandler },
      { getServerEnv },
      { createRedisStore },
      { createObjectStore },
      { auth },
      { createEmailSender },
    ]) => {
      const env = getServerEnv();
      const operationLimiter = new OperationLimiter(
        createRedisStore(env),
        productionSecurityEventLogger,
        env.OPERATION_LIMIT_HMAC_KEY,
      );
      const objectStore = createObjectStore(env);
      const metrics = createTask12Metrics(productionMetricsSink);
      return createGraphQLHandler({
        auth,
        clientAddressConfig:
          env.TRUSTED_PROXY_MODE === "hmac"
            ? {
                deploymentMode: "docker",
                hmacKey: env.TRUSTED_PROXY_HMAC_KEY!,
                mode: "hmac",
              }
            : env.TRUSTED_PROXY_MODE === "vercel"
              ? { deploymentMode: "vercel", mode: "vercel" }
              : { deploymentMode: env.DEPLOYMENT_MODE, mode: "none" },
        database: db,
        databaseQueryDiagnostics: {
          enabled: process.env.GRAPH_PERFORMANCE_INSTRUMENTATION === "1",
          isolatedTestRuntime:
            env.NODE_ENV === "test" &&
            process.env.GRAPH_PERFORMANCE_TEST_RUNTIME === "1",
          secret: process.env.GRAPH_PERFORMANCE_DIAGNOSTIC_SECRET ?? "",
        },
        environment: env.NODE_ENV,
        logger: productionSecurityEventLogger,
        metrics,
        operationLimiter,
        searchIndexMaintenance: createSearchIndexMaintenance({ metrics }),
        searchRuntime: {
          cursorHmacKey: env.OPERATION_LIMIT_HMAC_KEY,
          encryptionKey: env.DATA_ENCRYPTION_KEY,
          protectedLookupHmacKey: env.PROTECTED_LOOKUP_HMAC_KEY,
        },
        fileRuntime: {
          objectStore,
          storageBucket: env.STORAGE_BUCKET,
          storageProvider: env.STORAGE_PROVIDER,
          encryptionKey: env.DATA_ENCRYPTION_KEY,
        },
        importRuntime: {
          encryptionKey: env.DATA_ENCRYPTION_KEY,
          objectStore,
        },
        settingsRuntime: {
          appUrl: env.NEXT_PUBLIC_APP_URL,
          authSecret: env.AUTH_SECRET,
          emailSender: createEmailSender(env),
          encryptionKey: env.AUTH_ENCRYPTION_KEY,
        },
        trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
      });
    },
  );
  return productionHandler;
}

async function handler(request: Request) {
  const requestId = createGraphQLRequestId(request);
  try {
    const productionHandler = await getProductionHandler();
    return await productionHandler(request, requestId);
  } catch {
    productionSecurityEventLogger.log({
      event: "graphql.initialization.internal",
      requestId,
      severity: "error",
    });
    return createGraphQLInternalErrorResponse(requestId);
  }
}

export { handler as GET, handler as OPTIONS, handler as POST };
