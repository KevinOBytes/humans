import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import type { ServerEnv } from "@/lib/env/server-schema";
import {
  ApplicationProxyObjectStore,
  storageObjectKey,
  validateFileName,
  validateUpload,
} from "@/lib/storage/proxy";
import type {
  DownloadRequest,
  ObjectMetadata,
  ObjectRead,
  ObjectReference,
  ObjectStore,
  SignedObjectRequest,
  UploadRequest,
} from "@/lib/storage/types";

export type ObjectStoreProvider = "minio" | "r2" | "s3";

export interface ObjectStoreConfigInput {
  endpoint: string;
  provider: ObjectStoreProvider;
  forcePathStyle?: boolean;
}

export function objectStoreConfig(
  input: ObjectStoreConfigInput,
): Pick<S3ClientConfig, "endpoint" | "forcePathStyle"> {
  return {
    endpoint: input.endpoint,
    forcePathStyle:
      input.provider === "minio" ? true : (input.forcePathStyle ?? false),
  };
}

export function s3ClientConfig(input: ObjectStoreConfigInput): S3ClientConfig {
  return {
    ...objectStoreConfig(input),
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 1_000,
      socketTimeout: 2_000,
    }),
  };
}

function providerFor(env: ServerEnv): ObjectStoreProvider {
  return env.STORAGE_PROVIDER;
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (candidate.name === "NoSuchBucket") return false;
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey"
  );
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly uploadTtlSeconds = 300,
    private readonly downloadTtlSeconds = 120,
  ) {}

  async checkReachability(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async createUpload(input: UploadRequest): Promise<SignedObjectRequest> {
    validateUpload(input);
    const now = Date.now();
    const expiresAt = new Date(
      Math.min(
        now + this.uploadTtlSeconds * 1_000,
        input.sessionExpiresAt.getTime(),
      ),
    );
    const expiresIn = Math.floor((expiresAt.getTime() - now) / 1_000);
    if (expiresIn < 1) throw new TypeError("Upload session has expired");
    const checksumSha256 = Buffer.from(input.checksumSha256, "hex").toString(
      "base64",
    );
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageObjectKey(input.workspaceId, input.key),
      ContentLength: input.bytes,
      ContentType: input.contentType,
      ChecksumSHA256: checksumSha256,
      Metadata: { "workspace-id": input.workspaceId },
    });

    return {
      method: "PUT",
      url: await getSignedUrl(this.client, command, {
        expiresIn,
        signableHeaders: new Set(["content-type"]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      }),
      expiresAt,
      contentLength: input.bytes,
      headers: {
        "content-type": input.contentType,
        "x-amz-checksum-sha256": checksumSha256,
      },
    };
  }

  async createDownload(input: DownloadRequest): Promise<SignedObjectRequest> {
    validateFileName(input.fileName);
    const expiresAt = new Date(Date.now() + this.downloadTtlSeconds * 1_000);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageObjectKey(input.workspaceId, input.key),
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.fileName)}`,
      ResponseContentType: "application/octet-stream",
    });

    return {
      method: "GET",
      url: await getSignedUrl(this.client, command, {
        expiresIn: this.downloadTtlSeconds,
      }),
      expiresAt,
      headers: {},
    };
  }

  async getMetadata(input: ObjectReference): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: storageObjectKey(input.workspaceId, input.key),
        }),
      );
      return {
        bytes: result.ContentLength,
        contentType: result.ContentType,
        etag: result.ETag,
        lastModified: result.LastModified,
        custom: result.Metadata ?? {},
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async exists(input: ObjectReference): Promise<boolean> {
    return (await this.getMetadata(input)) !== null;
  }

  async openRead(
    input: ObjectReference,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ObjectRead | null> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError("Invalid object read limit");
    }
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: storageObjectKey(input.workspaceId, input.key),
        }),
        { abortSignal: options.signal },
      );
      if (!result.Body) return null;
      const source = result.Body as AsyncIterable<Uint8Array>;
      const maxBytes = options.maxBytes;
      return {
        bytes: result.ContentLength,
        contentType: result.ContentType,
        body: (async function* () {
          let bytes = 0;
          for await (const raw of source) {
            const chunk = new Uint8Array(raw);
            bytes += chunk.byteLength;
            if (bytes > maxBytes) throw new Error("Object read limit exceeded");
            yield chunk;
          }
        })(),
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async delete(input: ObjectReference): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: storageObjectKey(input.workspaceId, input.key),
      }),
    );
  }
}

export function createS3Client(env: ServerEnv): S3Client {
  return new S3Client({
    ...s3ClientConfig({
      endpoint: env.STORAGE_ENDPOINT,
      provider: providerFor(env),
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    }),
    region: env.STORAGE_REGION,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
}

export interface CreateObjectStoreOptions {
  client?: S3Client;
  now?: () => number;
}

export function createObjectStore(
  env: ServerEnv,
  options: CreateObjectStoreOptions = {},
): ObjectStore {
  const directStore = new S3ObjectStore(
    options.client ?? createS3Client(env),
    env.STORAGE_BUCKET,
  );
  return new ApplicationProxyObjectStore(
    directStore,
    env.NEXT_PUBLIC_APP_URL,
    env.DATA_ENCRYPTION_KEY,
    options.now,
  );
}
