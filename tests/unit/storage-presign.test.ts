import { createHash } from "node:crypto";

import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { S3ObjectStore } from "@/lib/storage/s3";

describe("direct S3 upload presigning", () => {
  it("binds method, workspace key, size, type, checksum, and expiry", async () => {
    const client = new S3Client({
      endpoint: "https://s3.example.test",
      forcePathStyle: true,
      region: "us-east-1",
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
    });
    const store = new S3ObjectStore(client, "humans-private");
    const body = "direct upload";
    const checksumSha256 = createHash("sha256").update(body).digest("hex");

    const result = await store.createUpload({
      workspaceId: "workspace-a",
      key: "evidence/file.txt",
      contentType: "text/plain",
      bytes: Buffer.byteLength(body),
      checksumSha256,
    });
    const url = new URL(result.url);
    const signedHeaders = new Set(
      (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";"),
    );

    expect(url.pathname).toBe(
      "/humans-private/workspaces/workspace-a/evidence/file.txt",
    );
    expect(signedHeaders).toEqual(
      new Set([
        "content-length",
        "content-type",
        "host",
        "x-amz-checksum-sha256",
      ]),
    );
    expect(url.searchParams.get("x-amz-checksum-sha256")).toBeNull();
    expect(result.headers["x-amz-checksum-sha256"]).toBe(
      Buffer.from(checksumSha256, "hex").toString("base64"),
    );
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.method).toBe("PUT");
    expect(result.headers["content-length"]).toBeUndefined();
    expect(result.contentLength).toBe(Buffer.byteLength(body));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 300_000,
    );
  });
});
