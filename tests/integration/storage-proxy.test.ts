import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createStorageProxyHandlers } from "@/app/api/storage/objects/[...path]/route";
import { parseServerEnv } from "@/lib/env/server-schema";
import { createObjectStore, S3ObjectStore } from "@/lib/storage/s3";
import type { SignedObjectRequest } from "@/lib/storage/types";

const baseEnv = parseServerEnv({
  NODE_ENV: "test",
  DEPLOYMENT_MODE: "docker",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://humans:password@postgres:5432/humans",
  REDIS_URL: "redis://:password@redis:6379",
  STORAGE_PROVIDER: "minio",
  STORAGE_ENDPOINT: "http://minio:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "humans-private",
  STORAGE_ACCESS_KEY_ID: "local-access",
  STORAGE_SECRET_ACCESS_KEY: "local-secret",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_BUCKET_PUBLIC: "false",
  AUTH_SECRET: "local-auth-secret-value",
  AUTH_SECURE_COOKIES: "false",
  AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
  AUTH_ENCRYPTION_KEY: "1".repeat(64),
  DATA_ENCRYPTION_KEY: "2".repeat(64),
  PROTECTED_LOOKUP_HMAC_KEY: "3".repeat(64),
  OPERATION_LIMIT_HMAC_KEY: "4".repeat(64),
  TRUSTED_PROXY_MODE: "none",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_USERNAME: "admin",
  ADMIN_DISPLAY_NAME: "Admin",
  ADMIN_PASSWORD: "local-admin-password",
  RESEND_API_KEY: "local-resend-key",
  EMAIL_FROM: "Humans <humans@example.com>",
  AI_PROVIDER: "ollama",
  AI_BASE_URL: "http://ollama:11434/v1",
  AI_MODEL: "test-model",
});

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

class MemoryS3Client {
  readonly objects = new Map<string, StoredObject>();
  readonly commands: string[] = [];

  async send(command: { input: Record<string, unknown> }): Promise<unknown> {
    this.commands.push(command.constructor.name);
    const key = String(command.input.Key);
    if (command.constructor.name === "PutObjectCommand") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of command.input
        .Body as AsyncIterable<Uint8Array>) {
        chunks.push(new Uint8Array(chunk));
      }
      this.objects.set(key, {
        body: Buffer.concat(chunks),
        contentType: command.input.ContentType as string | undefined,
      });
      return {};
    }
    if (command.constructor.name === "GetObjectCommand") {
      const object = this.objects.get(key);
      if (!object) throw new Error("missing test object");
      return {
        Body: Readable.from([object.body]),
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
      };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

class FailingDownloadClient {
  readonly commands: string[] = [];

  constructor(private readonly objectError: Error) {}

  async send(command: object): Promise<unknown> {
    this.commands.push(command.constructor.name);
    if (command.constructor.name === "GetObjectCommand") {
      throw this.objectError;
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  }
}

function checksum(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function uploadRequest(upload: SignedObjectRequest, body: string): Request {
  return new Request(upload.url, {
    method: upload.method,
    headers: {
      ...upload.headers,
      "content-length": String(upload.contentLength),
    },
    body,
  });
}

function grantRequest(grant: SignedObjectRequest): Request {
  return new Request(grant.url, {
    method: grant.method,
    headers: grant.headers,
  });
}

describe("local storage proxy", () => {
  it("uploads and downloads through an app URL scoped to workspace and key", async () => {
    let now = Date.UTC(2026, 6, 10);
    const client = new MemoryS3Client();
    const store = createObjectStore(baseEnv, { now: () => now });
    const handlers = createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: baseEnv.STORAGE_BUCKET,
      secret: baseEnv.DATA_ENCRYPTION_KEY,
      now: () => now,
    });
    const body = "evidence from a host browser";
    const digest = checksum(body);

    const upload = await store.createUpload({
      workspaceId: "workspace-a",
      key: "evidence/file.txt",
      contentType: "text/plain",
      bytes: Buffer.byteLength(body),
      checksumSha256: digest,
    });

    expect(new URL(upload.url).origin).toBe("http://localhost:3000");
    expect(upload.url).not.toContain("minio");
    expect(upload.url).not.toContain(baseEnv.STORAGE_SECRET_ACCESS_KEY);
    expect(upload.headers).toMatchObject({
      "content-type": "text/plain",
      "x-humans-content-sha256": digest,
    });
    expect(upload.headers.authorization).toMatch(/^StorageGrant /u);
    expect(upload.contentLength).toBe(Buffer.byteLength(body));
    const uploadResponse = await handlers.PUT(uploadRequest(upload, body));
    expect(uploadResponse.status).toBe(204);
    expect(client.objects.has("workspaces/workspace-a/evidence/file.txt")).toBe(
      true,
    );

    now += 1_000;
    const download = await store.createDownload({
      workspaceId: "workspace-a",
      key: "evidence/file.txt",
      fileName: "research notes.txt",
    });
    const downloadResponse = await handlers.GET(grantRequest(download));

    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe(body);
    expect(downloadResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(downloadResponse.headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    expect(downloadResponse.headers.get("content-disposition")).toContain(
      "research%20notes.txt",
    );
  });

  it("rejects method, scope, expiry, size, type, and checksum tampering", async () => {
    let now = Date.UTC(2026, 6, 10);
    const client = new MemoryS3Client();
    const store = createObjectStore(baseEnv, { now: () => now });
    const handlers = createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: baseEnv.STORAGE_BUCKET,
      secret: baseEnv.DATA_ENCRYPTION_KEY,
      now: () => now,
    });
    const body = "safe";
    const digest = checksum(body);
    const upload = await store.createUpload({
      workspaceId: "workspace-a",
      key: "safe.txt",
      contentType: "text/plain",
      bytes: 4,
      checksumSha256: digest,
    });

    expect(
      (await handlers.GET(new Request(upload.url, { headers: upload.headers })))
        .status,
    ).toBe(403);

    const authorization = upload.headers.authorization!;
    const tamperedAuthorization = `${authorization.slice(0, -1)}${authorization.endsWith("A") ? "B" : "A"}`;
    expect(
      (
        await handlers.PUT(
          new Request(upload.url, {
            method: upload.method,
            headers: {
              ...upload.headers,
              authorization: tamperedAuthorization,
              "content-length": String(upload.contentLength),
            },
            body,
          }),
        )
      ).status,
    ).toBe(403);

    const constraintCases = [
      {
        headers: {
          ...upload.headers,
          "content-length": "5",
        },
      },
      {
        headers: {
          ...upload.headers,
          "content-length": String(upload.contentLength),
          "content-type": "text/html",
        },
      },
      {
        headers: {
          ...upload.headers,
          "content-length": String(upload.contentLength),
          "x-humans-content-sha256": "0".repeat(64),
        },
      },
    ];
    for (const testCase of constraintCases) {
      const response = await handlers.PUT(
        new Request(upload.url, {
          method: upload.method,
          headers: testCase.headers,
          body,
        }),
      );
      expect(response.status).toBe(400);
    }

    const corruptedBody = "safx";
    expect(
      (
        await handlers.PUT(
          new Request(upload.url, {
            method: upload.method,
            headers: {
              ...upload.headers,
              "content-length": String(upload.contentLength),
            },
            body: corruptedBody,
          }),
        )
      ).status,
    ).toBe(400);
    expect(client.commands).toEqual(["PutObjectCommand"]);
    expect(client.objects.size).toBe(0);

    now = upload.expiresAt.getTime() + 1;
    expect(
      (
        await handlers.PUT(
          new Request(upload.url, {
            method: upload.method,
            headers: {
              ...upload.headers,
              "content-length": String(upload.contentLength),
            },
            body,
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("keeps managed S3 deployments on direct presigning", () => {
    const store = createObjectStore({
      ...baseEnv,
      DEPLOYMENT_MODE: "vercel",
      STORAGE_PROVIDER: "r2",
      STORAGE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      STORAGE_REGION: "auto",
      STORAGE_FORCE_PATH_STYLE: false,
    });

    expect(store).toBeInstanceOf(S3ObjectStore);
  });

  it("returns fixed 404 for an explicit missing key", async () => {
    const error = Object.assign(new Error("secret object detail"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const client = new FailingDownloadClient(error);
    const store = createObjectStore(baseEnv);
    const handlers = createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: baseEnv.STORAGE_BUCKET,
      secret: baseEnv.DATA_ENCRYPTION_KEY,
    });
    const download = await store.createDownload({
      workspaceId: "workspace-a",
      key: "missing.txt",
      fileName: "missing.txt",
    });

    const response = await handlers.GET(grantRequest(download));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "error" });
    expect(client.commands).toEqual(["GetObjectCommand"]);
  });

  it("returns fixed 404 for ambiguous object absence without probing the bucket", async () => {
    const error = Object.assign(new Error("ambiguous not found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    const client = new FailingDownloadClient(error);
    const store = createObjectStore(baseEnv);
    const handlers = createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: baseEnv.STORAGE_BUCKET,
      secret: baseEnv.DATA_ENCRYPTION_KEY,
    });
    const download = await store.createDownload({
      workspaceId: "workspace-a",
      key: "missing.txt",
      fileName: "missing.txt",
    });

    const response = await handlers.GET(grantRequest(download));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "error" });
    expect(client.commands).toEqual(["GetObjectCommand"]);
  });

  it("returns fixed 503 when the object response identifies a missing bucket", async () => {
    const objectError = Object.assign(new Error("secret bucket endpoint"), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });
    const client = new FailingDownloadClient(objectError);
    const store = createObjectStore(baseEnv);
    const handlers = createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: baseEnv.STORAGE_BUCKET,
      secret: baseEnv.DATA_ENCRYPTION_KEY,
    });
    const download = await store.createDownload({
      workspaceId: "workspace-a",
      key: "missing.txt",
      fileName: "missing.txt",
    });

    const response = await handlers.GET(grantRequest(download));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
    expect(client.commands).toEqual(["GetObjectCommand"]);
  });

  it.each([
    ["authorization", "AccessDenied", 403],
    ["timeout", "TimeoutError", undefined],
    ["provider failure", "InternalError", 503],
  ])("redacts secret-bearing %s download errors", async (_, name, status) => {
    const error = Object.assign(
      new Error("https://access:secret@storage.internal/private"),
      {
        name,
        ...(status === undefined
          ? {}
          : { $metadata: { httpStatusCode: status } }),
      },
    );
    const client = new FailingDownloadClient(error);
    const store = createObjectStore(baseEnv);
    const handlers = createStorageProxyHandlers({
      client: client as unknown as S3Client,
      bucket: baseEnv.STORAGE_BUCKET,
      secret: baseEnv.DATA_ENCRYPTION_KEY,
    });
    const download = await store.createDownload({
      workspaceId: "workspace-a",
      key: "private.txt",
      fileName: "private.txt",
    });

    const response = await handlers.GET(grantRequest(download));
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(responseText).toBe('{"status":"error"}');
    expect(responseText).not.toContain("secret");
    expect(responseText).not.toContain("storage.internal");
    expect(client.commands).toEqual(["GetObjectCommand"]);
  });
});
