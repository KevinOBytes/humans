import { getServerEnv } from "@/lib/env/server";
import { productionSecurityEventLogger } from "@/lib/observability/security-events";
import {
  createStorageProxyHandlers,
  storageErrorResponse,
  storageRequestId,
  type StorageProxyOptions,
} from "@/lib/storage/proxy";
import { createS3Client } from "@/lib/storage/s3";
import { createUploadSessionProxyExecutor } from "@/modules/files/upload-proxy";

function defaultHandlers(): Promise<StorageHandlers> {
  // createStorageRouteHandlers owns the retryable initialization cache.
  return import("@/db/client").then(({ db }) => {
    const env = getServerEnv();
    const options: StorageProxyOptions = {
      client: createS3Client(env),
      bucket: env.STORAGE_BUCKET,
      secret: env.DATA_ENCRYPTION_KEY,
      executeAuthorizedUpload: createUploadSessionProxyExecutor({
        database: db,
        deploymentMode: env.DEPLOYMENT_MODE,
      }),
    };
    return createStorageProxyHandlers(options);
  });
}

type StorageHandlers = ReturnType<typeof createStorageProxyHandlers>;
type StorageHandlerLoader = () => Promise<StorageHandlers>;
type StorageInfrastructureLogger = {
  log(event: {
    event: "storage.infrastructure.failure";
    requestId: string;
    severity: "error";
  }): void;
};

const fallbackInfrastructureLogger: StorageInfrastructureLogger =
  productionSecurityEventLogger;

/**
 * Keep failures during environment/client initialization inside the same
 * correlated, redacted boundary as storage provider failures. A rejected
 * loader is evicted so a transient outage can recover on the next request.
 */
export function createStorageRouteHandlers(
  loader: StorageHandlerLoader,
  logger: StorageInfrastructureLogger = fallbackInfrastructureLogger,
): StorageHandlers {
  let pending: Promise<StorageHandlers> | undefined;
  const load = (): Promise<StorageHandlers> => {
    if (!pending) {
      const current = Promise.resolve().then(loader);
      pending = current;
      void current.catch(() => {
        if (pending === current) pending = undefined;
      });
    }
    return pending;
  };

  const call = async (
    method: keyof StorageHandlers,
    request: Request,
  ): Promise<Response> => {
    const requestId = storageRequestId(request);
    try {
      return await (await load())[method](request);
    } catch {
      logger.log({
        event: "storage.infrastructure.failure",
        requestId,
        severity: "error",
      });
      return storageErrorResponse(503, requestId);
    }
  };

  return {
    GET: (request) => call("GET", request),
    PUT: (request) => call("PUT", request),
  };
}

export const { GET, PUT } = createStorageRouteHandlers(defaultHandlers);
