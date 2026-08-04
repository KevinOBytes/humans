import { getServerEnv } from "@/lib/env/server";
import { createS3Client } from "@/lib/storage/s3";
import {
  createStorageProxyHandlers,
  type StorageProxyOptions,
} from "@/lib/storage/proxy";
import { createUploadSessionProxyExecutor } from "@/modules/files/upload-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let handlers:
  Promise<ReturnType<typeof createStorageProxyHandlers>> | undefined;

function defaultHandlers(): Promise<
  ReturnType<typeof createStorageProxyHandlers>
> {
  handlers ??= import("@/db/client").then(({ db }) => {
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
  return handlers;
}

export async function PUT(request: Request): Promise<Response> {
  return (await defaultHandlers()).PUT(request);
}

export async function GET(request: Request): Promise<Response> {
  return (await defaultHandlers()).GET(request);
}
