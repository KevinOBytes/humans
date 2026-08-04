import { getServerEnv } from "@/lib/env/server";
import { createS3Client } from "@/lib/storage/s3";
import {
  createStorageProxyHandlers,
  type StorageProxyOptions,
} from "@/lib/storage/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let handlers: ReturnType<typeof createStorageProxyHandlers> | undefined;

function defaultHandlers():
  ReturnType<typeof createStorageProxyHandlers> | undefined {
  const env = getServerEnv();
  if (env.DEPLOYMENT_MODE !== "docker" || env.STORAGE_PROVIDER !== "minio") {
    return undefined;
  }
  const options: StorageProxyOptions = {
    client: createS3Client(env),
    bucket: env.STORAGE_BUCKET,
    secret: env.DATA_ENCRYPTION_KEY,
  };
  handlers ??= createStorageProxyHandlers(options);
  return handlers;
}

export async function PUT(request: Request): Promise<Response> {
  return (
    (await defaultHandlers()?.PUT(request)) ??
    Response.json({ status: "not_found" }, { status: 404 })
  );
}

export async function GET(request: Request): Promise<Response> {
  return (
    (await defaultHandlers()?.GET(request)) ??
    Response.json({ status: "not_found" }, { status: 404 })
  );
}
