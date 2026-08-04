import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env/server-schema";
import {
  createObjectStore,
  createS3Client,
  S3ObjectStore,
} from "@/lib/storage/s3";
import type { ObjectStore, SignedObjectRequest } from "@/lib/storage/types";
import { seedStorageUploadSession } from "../support/storage-upload-session";

const runSmoke = process.env.RUN_STORAGE_PROXY_MINIO_SMOKE === "true";
if (runSmoke) process.loadEnvFile(".env.test.local");

describe.runIf(runSmoke)("MinIO storage proxy smoke", () => {
  async function executeUpload(
    store: ObjectStore,
    body: string,
    key: string,
    authority: {
      actorId: string;
      sessionExpiresAt: Date;
      uploadSessionId: string;
      workspaceId: string;
    },
  ): Promise<{ grant: SignedObjectRequest; response: Response }> {
    const grant = await store.createUpload({
      ...authority,
      key,
      contentType: "text/plain",
      bytes: Buffer.byteLength(body),
      checksumSha256: createHash("sha256").update(body).digest("hex"),
    });
    return {
      grant,
      response: await fetch(grant.url, {
        method: grant.method,
        headers: grant.headers,
        body,
      }),
    };
  }

  it("executes proxy and direct grants through the shared request interface", async () => {
    const env = parseServerEnv(process.env);
    const store = createObjectStore(env);
    const body = `real MinIO proxy ${randomUUID()}`;
    const key = `smoke/${randomUUID()}.txt`;
    const digest = createHash("sha256").update(body).digest("hex");
    const session = await seedStorageUploadSession({
      bytes: Buffer.byteLength(body),
      checksumSha256: digest,
      contentType: "text/plain",
      databaseUrl: env.DATABASE_URL,
      key,
      originalName: "runtime-smoke.txt",
    });

    const proxyUpload = await executeUpload(store, body, key, session);
    expect(proxyUpload.response.status).toBe(204);

    const download = await store.createDownload({
      workspaceId: session.workspaceId,
      key,
      fileName: "runtime-smoke.txt",
    });
    const downloadResponse = await fetch(download.url, {
      headers: download.headers,
    });

    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe(body);
    expect(downloadResponse.headers.get("content-disposition")).toContain(
      "runtime-smoke.txt",
    );

    const directStore = new S3ObjectStore(
      createS3Client(env),
      env.STORAGE_BUCKET,
    );
    const directUpload = await executeUpload(
      directStore,
      `${body}-direct`,
      `smoke/${randomUUID()}-direct.txt`,
      {
        actorId: session.actorId,
        uploadSessionId: randomUUID(),
        sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
        workspaceId: session.workspaceId,
      },
    );
    expect(directUpload.response.status).toBe(200);
    await store.delete({ workspaceId: session.workspaceId, key });
    await session.cleanup();
  });
});
