import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import type {
  DownloadRequest,
  ObjectMetadata,
  ObjectRead,
  ObjectReference,
  ObjectStore,
  SignedObjectRequest,
  UploadRequest,
} from "@/lib/storage/types";

const proxyPath = "/api/storage/objects";
const MAX_PROXY_BYTES = 50 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 60_000;

type UploadGrant = {
  version: 1;
  operation: "upload";
  workspaceId: string;
  key: string;
  expiresAt: number;
  contentType: string;
  bytes: number;
  checksumSha256: string;
  nonce: string;
};

type DownloadGrant = {
  version: 1;
  operation: "download";
  workspaceId: string;
  key: string;
  expiresAt: number;
  fileName: string;
  nonce: string;
};

type StorageGrant = UploadGrant | DownloadGrant;

class ProxyRequestError extends Error {
  constructor(readonly status: number) {
    super("Storage proxy request rejected");
  }
}

function validateWorkspaceId(workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(workspaceId)) {
    throw new TypeError("Invalid workspace ID");
  }
  return workspaceId;
}

function validateKey(key: string): string {
  if (
    key.length === 0 ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(key) ||
    key
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("Invalid object key");
  }
  return key;
}

export function validateFileName(fileName: string): string {
  if (
    fileName.length === 0 ||
    Buffer.byteLength(fileName, "utf8") > 255 ||
    /[\u0000-\u001f\u007f]/u.test(fileName)
  ) {
    throw new TypeError("Invalid file name");
  }
  return fileName;
}

export function validateUpload(input: UploadRequest): UploadRequest {
  validateWorkspaceId(input.workspaceId);
  validateKey(input.key);
  if (
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > MAX_PROXY_BYTES ||
    input.contentType.length === 0 ||
    input.contentType.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(input.contentType) ||
    !/^[a-f0-9]{64}$/u.test(input.checksumSha256)
  ) {
    throw new TypeError("Invalid upload constraints");
  }
  return input;
}

export function storageObjectKey(workspaceId: string, key: string): string {
  return `workspaces/${validateWorkspaceId(workspaceId)}/${validateKey(key)}`;
}

function parseGrant(value: string): StorageGrant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProxyRequestError(403);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProxyRequestError(403);
  }
  const candidate = parsed as Record<string, unknown>;
  const expectedKeys =
    candidate.operation === "upload"
      ? [
          "bytes",
          "checksumSha256",
          "contentType",
          "expiresAt",
          "key",
          "nonce",
          "operation",
          "version",
          "workspaceId",
        ]
      : [
          "expiresAt",
          "fileName",
          "key",
          "nonce",
          "operation",
          "version",
          "workspaceId",
        ];
  if (
    Object.keys(candidate).sort().join("\0") !==
      expectedKeys.sort().join("\0") ||
    candidate.version !== 1 ||
    (candidate.operation !== "upload" && candidate.operation !== "download") ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.key !== "string" ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    typeof candidate.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(candidate.nonce)
  ) {
    throw new ProxyRequestError(403);
  }
  try {
    validateWorkspaceId(candidate.workspaceId);
    validateKey(candidate.key);
    if (candidate.operation === "upload") {
      validateUpload(candidate as unknown as UploadGrant);
    } else if (typeof candidate.fileName !== "string") {
      throw new TypeError("Invalid file name");
    } else {
      validateFileName(candidate.fileName);
    }
  } catch {
    throw new ProxyRequestError(403);
  }
  return candidate as unknown as StorageGrant;
}

function bearer(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = /^StorageGrant ([A-Za-z0-9_.-]+)$/u.exec(value);
  if (!match) throw new ProxyRequestError(401);
  return match[1]!;
}

function grantForRequest(
  request: Request,
  secret: string,
  operation: StorageGrant["operation"],
  now: number,
): StorageGrant {
  let grant: StorageGrant;
  try {
    grant = parseGrant(
      openSealedEnvelope({
        key: secret,
        purpose: `storage-${operation}`,
        token: bearer(request),
      }),
    );
  } catch (error) {
    if (error instanceof ProxyRequestError) throw error;
    throw new ProxyRequestError(403);
  }
  if (grant.operation !== operation) throw new ProxyRequestError(403);
  if (grant.expiresAt <= now) throw new ProxyRequestError(401);
  return grant;
}

function failure(status: number): Response {
  return Response.json(
    { status: "error" },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}

function storageError(error: unknown): {
  name?: string;
  status?: number;
} {
  if (!error || typeof error !== "object") return {};
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    name: candidate.name,
    status: candidate.$metadata?.httpStatusCode,
  };
}

function downloadFailureStatus(error: unknown): 404 | 503 {
  const details = storageError(error);
  if (details.name === "NoSuchKey") return 404;
  const ambiguousObjectAbsence =
    details.name !== "NoSuchBucket" &&
    (details.name === "NotFound" || details.status === 404);
  return ambiguousObjectAbsence ? 404 : 503;
}

function responseBody(body: unknown): BodyInit | null {
  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
  };
  if (typeof candidate?.transformToWebStream === "function") {
    return candidate.transformToWebStream();
  }
  if (body && Symbol.asyncIterator in Object(body)) {
    return Readable.toWeb(
      Readable.from(body as AsyncIterable<Uint8Array>),
    ) as ReadableStream<Uint8Array>;
  }
  return null;
}

export interface StorageProxyOptions {
  client: S3Client;
  bucket: string;
  secret: string;
  now?: () => number;
}

export function createStorageProxyHandlers(options: StorageProxyOptions): {
  PUT(request: Request): Promise<Response>;
  GET(request: Request): Promise<Response>;
} {
  const now = options.now ?? Date.now;
  return {
    PUT: async (request) => {
      let grant: UploadGrant;
      try {
        grant = grantForRequest(
          request,
          options.secret,
          "upload",
          now(),
        ) as UploadGrant;
        if (
          request.headers.get("content-length") !== String(grant.bytes) ||
          request.headers.get("content-type") !== grant.contentType ||
          request.headers.get("x-humans-content-sha256") !==
            grant.checksumSha256 ||
          !request.body
        ) {
          throw new ProxyRequestError(400);
        }
      } catch (error) {
        return failure(error instanceof ProxyRequestError ? error.status : 403);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      let invalidBody = false;
      let bytes = 0;
      const hash = createHash("sha256");
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          if (bytes > grant.bytes) {
            invalidBody = true;
            callback(new Error("upload body too large"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
        flush(callback) {
          if (
            bytes !== grant.bytes ||
            hash.digest("hex") !== grant.checksumSha256
          ) {
            invalidBody = true;
            callback(new Error("upload body mismatch"));
            return;
          }
          callback();
        },
      });
      try {
        const body = Readable.from(
          request.body as unknown as AsyncIterable<Uint8Array>,
        ).pipe(verify);
        await options.client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: storageObjectKey(grant.workspaceId, grant.key),
            Body: body,
            ContentLength: grant.bytes,
            ContentType: grant.contentType,
            ChecksumSHA256: Buffer.from(grant.checksumSha256, "hex").toString(
              "base64",
            ),
            Metadata: { "workspace-id": grant.workspaceId },
          }),
          { abortSignal: controller.signal },
        );
        return new Response(null, {
          status: 204,
          headers: { "cache-control": "private, no-store" },
        });
      } catch {
        return failure(invalidBody ? 400 : 503);
      } finally {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
      }
    },

    GET: async (request) => {
      let grant: DownloadGrant;
      try {
        grant = grantForRequest(
          request,
          options.secret,
          "download",
          now(),
        ) as DownloadGrant;
      } catch (error) {
        return failure(error instanceof ProxyRequestError ? error.status : 403);
      }
      try {
        const result = await options.client.send(
          new GetObjectCommand({
            Bucket: options.bucket,
            Key: storageObjectKey(grant.workspaceId, grant.key),
          }),
        );
        const body = responseBody(result.Body);
        if (!body) return failure(404);
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            ...(result.ContentLength == null
              ? {}
              : { "content-length": String(result.ContentLength) }),
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(grant.fileName)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return failure(downloadFailureStatus(error));
      }
    },
  };
}

export class ApplicationProxyObjectStore implements ObjectStore {
  constructor(
    private readonly delegate: ObjectStore,
    private readonly appUrl: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly uploadTtlSeconds = 300,
    private readonly downloadTtlSeconds = 120,
  ) {}

  private token(grant: StorageGrant): string {
    return sealEnvelope({
      key: this.secret,
      plaintext: JSON.stringify(grant),
      purpose: `storage-${grant.operation}`,
    });
  }

  async createUpload(input: UploadRequest): Promise<SignedObjectRequest> {
    validateUpload(input);
    const expiresAt = new Date(this.now() + this.uploadTtlSeconds * 1_000);
    const grant: UploadGrant = {
      version: 1,
      operation: "upload",
      workspaceId: input.workspaceId,
      key: input.key,
      expiresAt: expiresAt.getTime(),
      contentType: input.contentType,
      bytes: input.bytes,
      checksumSha256: input.checksumSha256,
      nonce: crypto.randomUUID().replaceAll("-", ""),
    };
    return {
      method: "PUT",
      url: new URL(proxyPath, this.appUrl).toString(),
      expiresAt,
      contentLength: input.bytes,
      headers: {
        authorization: `StorageGrant ${this.token(grant)}`,
        "content-type": input.contentType,
        "x-humans-content-sha256": input.checksumSha256,
      },
    };
  }

  async createDownload(input: DownloadRequest): Promise<SignedObjectRequest> {
    validateWorkspaceId(input.workspaceId);
    validateKey(input.key);
    validateFileName(input.fileName);
    const expiresAt = new Date(this.now() + this.downloadTtlSeconds * 1_000);
    const grant: DownloadGrant = {
      version: 1,
      operation: "download",
      workspaceId: input.workspaceId,
      key: input.key,
      expiresAt: expiresAt.getTime(),
      fileName: input.fileName,
      nonce: crypto.randomUUID().replaceAll("-", ""),
    };
    return {
      method: "GET",
      url: new URL(proxyPath, this.appUrl).toString(),
      expiresAt,
      headers: { authorization: `StorageGrant ${this.token(grant)}` },
    };
  }

  checkReachability(): Promise<void> {
    return this.delegate.checkReachability();
  }
  getMetadata(input: ObjectReference): Promise<ObjectMetadata | null> {
    return this.delegate.getMetadata(input);
  }
  openRead(
    input: ObjectReference,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ObjectRead | null> {
    return this.delegate.openRead(input, options);
  }
  exists(input: ObjectReference): Promise<boolean> {
    return this.delegate.exists(input);
  }
  delete(input: ObjectReference): Promise<void> {
    return this.delegate.delete(input);
  }
}
