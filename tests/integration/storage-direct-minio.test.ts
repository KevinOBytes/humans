import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env/server-schema";
import { createS3Client, S3ObjectStore } from "@/lib/storage/s3";

const runSmoke = process.env.RUN_STORAGE_DIRECT_MINIO_SMOKE === "true";

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

describe.runIf(runSmoke)("direct MinIO presign constraints", () => {
  it("rejects wrong method, size, type, checksum, and expiry", async () => {
    const env = parseServerEnv(process.env);
    const store = new S3ObjectStore(createS3Client(env), env.STORAGE_BUCKET, 1);
    const body = `direct-${randomUUID()}`;
    const input = {
      actorId: "direct-smoke-actor",
      uploadSessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
      workspaceId: "direct-smoke",
      key: `${randomUUID()}.txt`,
      contentType: "text/plain",
      bytes: Buffer.byteLength(body),
      checksumSha256: sha256(body),
    };

    const upload = await store.createUpload(input);
    const signedHeaders = new URL(upload.url).searchParams.get(
      "X-Amz-SignedHeaders",
    );
    expect(signedHeaders?.split(";")).toContain("content-length");
    expect(signedHeaders?.split(";")).toContain("content-type");
    expect(signedHeaders?.split(";")).toContain("x-amz-checksum-sha256");

    const signedUploadHeaders = upload.headers;

    const correct = await fetch(upload.url, {
      method: upload.method,
      headers: signedUploadHeaders,
      body,
    });
    expect(correct.status).toBe(200);

    expect((await fetch(upload.url)).status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await fetch(upload.url, {
          method: upload.method,
          headers: { ...signedUploadHeaders, "content-type": "text/html" },
          body,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await fetch(upload.url, {
          method: upload.method,
          headers: {
            ...signedUploadHeaders,
            "content-length": String(input.bytes + 1),
          },
          body: `${body}x`,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);

    const corrupted = `${body.slice(0, -1)}x`;
    expect(Buffer.byteLength(corrupted)).toBe(input.bytes);
    expect(
      (
        await fetch(upload.url, {
          method: upload.method,
          headers: signedUploadHeaders,
          body: corrupted,
        })
      ).status,
    ).toBe(400);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      (
        await fetch(upload.url, {
          method: upload.method,
          headers: signedUploadHeaders,
          body,
        })
      ).status,
    ).toBe(403);
  });
});
