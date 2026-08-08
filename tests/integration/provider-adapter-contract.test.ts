import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Redis as UpstashClient } from "@upstash/redis";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LocalRedisStore,
  UpstashRedisStore,
  type RedisStore,
} from "@/lib/redis";
import {
  s3ClientConfig,
  S3ObjectStore,
  type ObjectStoreProvider,
} from "@/lib/storage/s3";

/**
 * The production Redis boundary is intentionally exercised with both client
 * shapes. The second shape uses the same Redis server through an Upstash REST
 * compatible facade, so a provider-specific serialization change cannot pass
 * unnoticed in one implementation only.
 */
class UpstashRedisBridge {
  constructor(private readonly client: IORedis) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  set(
    key: string,
    value: string,
    options?: { px?: number; nx?: true },
  ): Promise<"OK" | null> {
    if (options?.nx) {
      return options.px === undefined
        ? this.client.set(key, value, "NX")
        : this.client.set(key, value, "PX", options.px, "NX");
    }
    if (options?.px !== undefined) {
      return this.client.set(key, value, "PX", options.px);
    }
    return this.client.set(key, value);
  }

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  incrby(key: string, amount: number): Promise<number> {
    return this.client.incrby(key, amount);
  }

  eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args.map(String));
  }
}

function redisAdapters(client: IORedis): Array<{
  name: string;
  store: RedisStore;
}> {
  return [
    { name: "local", store: new LocalRedisStore(client) },
    {
      name: "upstash-shaped",
      store: new UpstashRedisStore(
        new UpstashRedisBridge(client) as unknown as UpstashClient,
      ),
    },
  ];
}

const redisUrl = process.env.REDIS_TEST_URL;
const runRedis = Boolean(redisUrl);

describe.runIf(runRedis)("Redis provider adapter contract", () => {
  let client: IORedis;
  let adapters: Array<{ name: string; store: RedisStore }>;
  const keys: string[] = [];

  beforeAll(async () => {
    client = new IORedis(redisUrl!, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
    });
    await client.ping();
    adapters = redisAdapters(client);
  });

  afterAll(async () => {
    if (keys.length) await client.del(...keys);
    await client.quit();
  });

  it.each(["local", "upstash-shaped"])(
    "preserves the complete RedisStore lifecycle for %s",
    async (name) => {
      const store = adapters.find((adapter) => adapter.name === name)?.store;
      if (!store) throw new Error(`Missing ${name} adapter`);
      const prefix = `nfr002:${name}:${randomUUID()}`;
      const valueKey = `${prefix}:value`;
      const counterKey = `${prefix}:counter`;
      const leaseKey = `${prefix}:lease`;
      const bucketKey = `${prefix}:bucket`;
      keys.push(valueKey, counterKey, leaseKey, bucketKey);

      await store.set(valueKey, "value", { expiresInMs: 10_000 });
      await expect(store.get(valueKey)).resolves.toBe("value");
      await expect(store.increment(counterKey, 2)).resolves.toBe(2);
      await expect(store.increment(counterKey)).resolves.toBe(3);

      await expect(store.acquireLease(leaseKey, "owner", 5_000)).resolves.toBe(
        true,
      );
      await expect(
        store.extendLease(leaseKey, "intruder", 10_000),
      ).resolves.toBe(false);
      await expect(store.extendLease(leaseKey, "owner", 10_000)).resolves.toBe(
        true,
      );
      await expect(store.releaseLease(leaseKey, "owner")).resolves.toBe(true);

      await expect(
        store.consumeTokenBucket({
          capacity: 2,
          cost: 1,
          key: bucketKey,
          refillAmount: 1,
          refillIntervalMs: 1_000,
          ttlMs: 2_000,
        }),
      ).resolves.toMatchObject({ allowed: true });
      await expect(store.delete(valueKey)).resolves.toBeUndefined();
      await expect(store.get(valueKey)).resolves.toBeNull();
    },
  );
});

const storageEndpoint = process.env.TEST_STORAGE_ENDPOINT;
const storageAccessKeyId = process.env.TEST_STORAGE_ACCESS_KEY_ID;
const storageSecretAccessKey = process.env.TEST_STORAGE_SECRET_ACCESS_KEY;
const runStorage = Boolean(
  storageEndpoint && storageAccessKeyId && storageSecretAccessKey,
);
const configuredStorageProvider = process.env.TEST_STORAGE_PROVIDER;
const storageProvider: ObjectStoreProvider =
  configuredStorageProvider === "r2" || configuredStorageProvider === "s3"
    ? configuredStorageProvider
    : "minio";

describe.runIf(runStorage)("S3-compatible provider adapter contract", () => {
  const bucket = process.env.TEST_STORAGE_BUCKET ?? "humans-provider-contract";
  const client = new S3Client({
    ...s3ClientConfig({
      endpoint: storageEndpoint!,
      provider: storageProvider,
    }),
    region: process.env.TEST_STORAGE_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: storageAccessKeyId!,
      secretAccessKey: storageSecretAccessKey!,
    },
  });
  const store = new S3ObjectStore(client, bucket);

  beforeAll(async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const candidate = error as {
        name?: unknown;
        $metadata?: { httpStatusCode?: unknown };
        $response?: { statusCode?: unknown };
      };
      const statusCode =
        candidate.$metadata?.httpStatusCode ?? candidate.$response?.statusCode;
      const missingBucket =
        statusCode === 404 ||
        candidate.name === "NotFound" ||
        candidate.name === "NoSuchBucket";
      if (!missingBucket) throw error;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });

  afterAll(() => client.destroy());

  it("round-trips a tenant-bound checksum object through signed operations", async () => {
    const workspaceId = `provider-contract-${randomUUID()}`;
    const key = `evidence/${randomUUID()}.txt`;
    const body = Buffer.from("provider adapter contract\n", "utf8");
    const checksum = createHash("sha256").update(body).digest("hex");

    const upload = await store.createUpload({
      actorId: "provider-contract-actor",
      uploadSessionId: randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      workspaceId,
      key,
      contentType: "text/plain",
      bytes: body.byteLength,
      checksumSha256: checksum,
    });
    const uploaded = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    expect([200, 204]).toContain(uploaded.status);

    await expect(store.exists({ workspaceId, key })).resolves.toBe(true);
    await expect(
      store.exists({ workspaceId: `${workspaceId}-other`, key }),
    ).resolves.toBe(false);
    await expect(
      store.getMetadata({ workspaceId, key }),
    ).resolves.toMatchObject({
      bytes: body.byteLength,
    });

    const opened = await store.openRead(
      { workspaceId, key },
      { maxBytes: body.byteLength },
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened?.body ?? []) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(body);

    const download = await store.createDownload({
      workspaceId,
      key,
      fileName: "evidence.txt",
    });
    const downloaded = await fetch(download.url, {
      method: download.method,
      headers: download.headers,
    });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(body);

    await store.delete({ workspaceId, key });
    await expect(store.exists({ workspaceId, key })).resolves.toBe(false);
  });
});
