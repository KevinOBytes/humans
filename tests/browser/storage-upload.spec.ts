import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { parseServerEnv } from "@/lib/env/server-schema";
import { createObjectStore } from "@/lib/storage/s3";

const runSmoke = process.env.RUN_STORAGE_BROWSER_MINIO_SMOKE === "true";
if (runSmoke) process.loadEnvFile(".env.test.local");

test.describe("browser storage grants", () => {
  test.skip(!runSmoke, "requires a running app and MinIO test stack");

  test("uploads a Blob using only the browser-safe grant headers", async ({
    page,
  }) => {
    const env = parseServerEnv(process.env);
    const store = createObjectStore(env);
    const body = `browser upload ${randomUUID()}`;
    const key = `browser/${randomUUID()}.txt`;
    const upload = await store.createUpload({
      workspaceId: "browser-smoke",
      key,
      contentType: "text/plain",
      bytes: Buffer.byteLength(body),
      checksumSha256: createHash("sha256").update(body).digest("hex"),
    });

    expect(upload.headers).not.toHaveProperty("content-length");
    expect(upload.contentLength).toBe(Buffer.byteLength(body));
    await page.goto(env.NEXT_PUBLIC_APP_URL);

    const uploadStatus = await page.evaluate(
      async ({ grant, content }) => {
        const blob = new Blob([content], { type: "text/plain" });
        const response = await fetch(grant.url, {
          method: grant.method,
          headers: grant.headers,
          body: blob,
        });
        return response.status;
      },
      { grant: upload, content: body },
    );
    expect(uploadStatus).toBe(204);

    const changedSizeStatus = await page.evaluate(
      async ({ grant, content }) => {
        const changedSizeBlob = new Blob([`${content}x`], {
          type: "text/plain",
        });
        const response = await fetch(grant.url, {
          method: grant.method,
          headers: grant.headers,
          body: changedSizeBlob,
        });
        return response.status;
      },
      { grant: upload, content: body },
    );
    expect(changedSizeStatus).toBe(400);

    const download = await store.createDownload({
      workspaceId: "browser-smoke",
      key,
      fileName: "browser-smoke.txt",
    });
    const downloaded = await page.evaluate(async (grant) => {
      const response = await fetch(grant.url, {
        method: grant.method,
        headers: grant.headers,
      });
      return { status: response.status, body: await response.text() };
    }, download);

    expect(downloaded).toEqual({ status: 200, body });
  });
});
