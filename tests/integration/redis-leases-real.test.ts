import type { Redis as UpstashClient } from "@upstash/redis";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OperationLimiter } from "@/graphql/operation-limiter";
import { classifyClientAddress } from "@/lib/network/client-address";
import {
  LocalRedisStore,
  UpstashRedisStore,
  redisLeaseScripts,
  type RedisStore,
} from "@/lib/redis";

const runSmoke = process.env.RUN_REDIS_LEASE_SMOKE === "true";

class UpstashRedisBridge {
  constructor(private readonly client: IORedis) {}

  set(
    key: string,
    value: string,
    options: { px: number; nx: true },
  ): Promise<"OK" | null> {
    return this.client.set(key, value, "PX", options.px, "NX");
  }

  async eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args.map(String));
  }
}

describe.runIf(runSmoke)("real Redis lease Lua", () => {
  let client: IORedis;
  let stores: Array<{ name: string; store: RedisStore }>;

  beforeAll(async () => {
    client = new IORedis(process.env.REDIS_TEST_URL!, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
    });
    await client.ping();
    stores = [
      { name: "local", store: new LocalRedisStore(client) },
      {
        name: "upstash-shaped",
        store: new UpstashRedisStore(
          new UpstashRedisBridge(client) as unknown as UpstashClient,
        ),
      },
    ];
  });

  afterAll(async () => {
    if (!client) return;
    const keys = [
      ...(await client.keys("task3-real-lease:*")),
      ...(await client.keys("task7-real-limit:*")),
    ];
    if (keys.length) await client.del(...keys);
    await client.quit();
  });

  it("executes ownership-sensitive extend and release for both adapters", async () => {
    for (const { name, store } of stores) {
      const key = `task3-real-lease:${name}:owner`;
      expect(await store.acquireLease(key, "owner", 2_000)).toBe(true);
      const originalTtl = await client.pttl(key);

      expect(await store.extendLease(key, "intruder", 10_000)).toBe(false);
      expect(await client.get(key)).toBe("owner");
      expect(await client.pttl(key)).toBeLessThanOrEqual(originalTtl);
      expect(await store.releaseLease(key, "intruder")).toBe(false);
      expect(await client.get(key)).toBe("owner");

      expect(await store.extendLease(key, "owner", 10_000)).toBe(true);
      expect(await client.pttl(key)).toBeGreaterThan(9_000);
      expect(await store.releaseLease(key, "owner")).toBe(true);
      expect(await client.exists(key)).toBe(0);
    }
  });

  it("allows both adapters to reacquire an expired lease", async () => {
    for (const { name, store } of stores) {
      const key = `task3-real-lease:${name}:expiry`;
      expect(await store.acquireLease(key, "first", 50)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await store.acquireLease(key, "second", 1_000)).toBe(true);
      expect(await client.get(key)).toBe("second");
    }
  });

  it("demonstrates unconditional Lua mutations violate ownership", async () => {
    const extendKey = "task3-real-lease:mutation:extend";
    await client.set(extendKey, "owner", "PX", 2_000);
    const unconditionalExtend = await client.eval(
      'return redis.call("pexpire", KEYS[1], ARGV[2])',
      1,
      extendKey,
      "intruder",
      "10000",
    );
    expect(unconditionalExtend).toBe(1);
    expect(await client.pttl(extendKey)).toBeGreaterThan(9_000);

    const releaseKey = "task3-real-lease:mutation:release";
    await client.set(releaseKey, "owner", "PX", 2_000);
    const unconditionalRelease = await client.eval(
      'return redis.call("del", KEYS[1])',
      1,
      releaseKey,
      "intruder",
    );
    expect(unconditionalRelease).toBe(1);
    expect(await client.exists(releaseKey)).toBe(0);

    expect(redisLeaseScripts.extend).toContain(
      'redis.call("get", KEYS[1]) == ARGV[1]',
    );
    expect(redisLeaseScripts.release).toContain(
      'redis.call("get", KEYS[1]) == ARGV[1]',
    );
  });

  it("atomically enforces a weighted boundary for both adapter shapes", async () => {
    for (const { name, store } of stores) {
      const key = `task7-real-limit:${name}:concurrent`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.consumeTokenBucket({
            capacity: 5,
            cost: 1,
            key,
            refillAmount: 5,
            refillIntervalMs: 60_000,
            ttlMs: 60_000,
          }),
        ),
      );

      expect(results.filter((result) => result.allowed)).toHaveLength(5);
      expect(results.filter((result) => !result.allowed)).toHaveLength(5);
      expect(await client.pttl(key)).toBeGreaterThan(59_000);
    }
  });

  it("uses Redis server time to refill microtokens and refresh expiry", async () => {
    for (const { name, store } of stores) {
      const key = `task7-real-limit:${name}:refill`;
      const empty = await store.consumeTokenBucket({
        capacity: 2,
        cost: 2,
        key,
        refillAmount: 1,
        refillIntervalMs: 1_000,
        ttlMs: 2_000,
      });
      expect(empty).toMatchObject({
        allowed: true,
        remainingMicrotokens: 0,
      });

      const [seconds, microseconds] = await client.time();
      const redisNowMs =
        Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
      await client.hset(key, {
        refill_remainder: "0",
        tokens: "0",
        updated_at_ms: String(redisNowMs - 250),
      });
      await client.pexpire(key, 10);

      const fractional = await store.consumeTokenBucket({
        capacity: 2,
        cost: 1,
        key,
        refillAmount: 1,
        refillIntervalMs: 1_000,
        ttlMs: 2_000,
      });
      expect(fractional.allowed).toBe(false);
      expect(fractional.remainingMicrotokens).toBeGreaterThanOrEqual(250_000);
      expect(fractional.remainingMicrotokens).toBeLessThan(350_000);
      expect(await client.pttl(key)).toBeGreaterThan(1_900);

      const [refillSeconds, refillMicroseconds] = await client.time();
      const refillNowMs =
        Number(refillSeconds) * 1_000 +
        Math.floor(Number(refillMicroseconds) / 1_000);
      await client.hset(key, {
        refill_remainder: "0",
        tokens: "0",
        updated_at_ms: String(refillNowMs - 1_000),
      });
      await client.pexpire(key, 10);

      const refilled = await store.consumeTokenBucket({
        capacity: 2,
        cost: 1,
        key,
        refillAmount: 1,
        refillIntervalMs: 1_000,
        ttlMs: 2_000,
      });
      expect(refilled.allowed).toBe(true);
      expect(refilled.remainingMicrotokens).toBeLessThan(50_000);
      expect(await client.pttl(key)).toBeGreaterThan(1_900);
    }
  });

  it("shares trusted and unknown client buckets while exposing only v2 HMAC keys", async () => {
    const key = "67".repeat(32);
    const primaryPolicy = {
      capacity: 100,
      refillAmount: 100,
      refillIntervalMs: 60_000,
      ttlMs: 60_000,
    };
    const clientPolicy = {
      capacity: 2,
      refillAmount: 2,
      refillIntervalMs: 60_000,
      ttlMs: 60_000,
    };
    const limiter = new OperationLimiter(
      new LocalRedisStore(client),
      undefined,
      key,
    );
    const request = (
      principalId: string,
      prefix: string | null,
      requestId: string,
    ) =>
      limiter.forRequest({
        actor: { id: principalId, principalId, type: "user" },
        clientAddress: prefix
          ? {
              family: prefix.includes(":") ? 6 : 4,
              prefix,
              source: "vercel",
              trust: "trusted",
            }
          : { reason: "missing", trust: "unknown" },
        requestId,
        workspaceId: "0198f25f-73fb-73ba-a524-8a33622988db",
      });
    const consume = (limiterRequest: ReturnType<typeof request>) =>
      limiterRequest.consume({
        clientPolicy,
        cost: 1,
        operationClass: "search.run",
        policy: primaryPolicy,
      });

    const shared = await Promise.allSettled([
      consume(
        request(
          "0198f260-dd7c-7d8d-852e-41b103d97d81",
          "203.0.113.0/24",
          "0198f27a-87e8-7fc6-b82f-97db38e9a681",
        ),
      ),
      consume(
        request(
          "0198f260-dd7c-7d8d-852e-41b103d97d82",
          "203.0.113.0/24",
          "0198f27a-87e8-7fc6-b82f-97db38e9a682",
        ),
      ),
      consume(
        request(
          "0198f260-dd7c-7d8d-852e-41b103d97d83",
          "203.0.113.0/24",
          "0198f27a-87e8-7fc6-b82f-97db38e9a683",
        ),
      ),
    ]);
    expect(shared.filter(({ status }) => status === "fulfilled")).toHaveLength(
      2,
    );
    expect(shared.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(
      consume(
        request(
          "0198f260-dd7c-7d8d-852e-41b103d97d84",
          "198.51.100.0/24",
          "0198f27a-87e8-7fc6-b82f-97db38e9a684",
        ),
      ),
    ).resolves.toMatchObject({ allowed: true });

    const ipv6Prefix = (address: string) => {
      const classification = classifyClientAddress(
        new Request("https://humans.test/graphql", {
          headers: { "x-vercel-forwarded-for": address },
        }),
        { deploymentMode: "vercel", mode: "vercel" },
      );
      expect(classification).toMatchObject({ family: 6, trust: "trusted" });
      if (classification.trust !== "trusted") {
        throw new Error("Expected a trusted IPv6 client classification.");
      }
      return classification.prefix;
    };
    const firstIpv6Prefix = ipv6Prefix("2001:db8:abcd:12::1");
    const sameIpv6Prefix = ipv6Prefix("2001:db8:abcd:12:ffff::beef");
    const otherIpv6Prefix = ipv6Prefix("2001:db8:abcd:13::1");
    expect(firstIpv6Prefix).toBe("2001:db8:abcd:12::/64");
    expect(sameIpv6Prefix).toBe(firstIpv6Prefix);
    expect(otherIpv6Prefix).toBe("2001:db8:abcd:13::/64");
    const consumeIpv6 = (
      principalId: string,
      prefix: string,
      requestId: string,
    ) =>
      request(principalId, prefix, requestId).consume({
        clientPolicy,
        cost: 1,
        operationClass: "search.ipv6",
        policy: primaryPolicy,
      });
    const sharedIpv6 = await Promise.allSettled([
      consumeIpv6(
        "0198f260-dd7c-7d8d-852e-41b103d97d91",
        firstIpv6Prefix,
        "0198f27a-87e8-7fc6-b82f-97db38e9a691",
      ),
      consumeIpv6(
        "0198f260-dd7c-7d8d-852e-41b103d97d92",
        sameIpv6Prefix,
        "0198f27a-87e8-7fc6-b82f-97db38e9a692",
      ),
      consumeIpv6(
        "0198f260-dd7c-7d8d-852e-41b103d97d93",
        firstIpv6Prefix,
        "0198f27a-87e8-7fc6-b82f-97db38e9a693",
      ),
    ]);
    expect(
      sharedIpv6.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(2);
    expect(
      sharedIpv6.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    await expect(
      consumeIpv6(
        "0198f260-dd7c-7d8d-852e-41b103d97d94",
        otherIpv6Prefix,
        "0198f27a-87e8-7fc6-b82f-97db38e9a694",
      ),
    ).resolves.toMatchObject({ allowed: true });

    const unknownPolicy = { ...clientPolicy, capacity: 1, refillAmount: 1 };
    const unknownConsume = (principalId: string, requestId: string) =>
      request(principalId, null, requestId).consume({
        clientPolicy: unknownPolicy,
        cost: 1,
        operationClass: "search.unknown",
        policy: primaryPolicy,
      });
    const unknown = await Promise.allSettled([
      unknownConsume(
        "0198f260-dd7c-7d8d-852e-41b103d97d85",
        "0198f27a-87e8-7fc6-b82f-97db38e9a685",
      ),
      unknownConsume(
        "0198f260-dd7c-7d8d-852e-41b103d97d86",
        "0198f27a-87e8-7fc6-b82f-97db38e9a686",
      ),
    ]);
    expect(unknown.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(unknown.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );

    const keys = await client.keys("humans:operation-limit:*");
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys.every((value) =>
        /^humans:operation-limit:v2:[0-9a-f]{64}$/u.test(value),
      ),
    ).toBe(true);
    expect(JSON.stringify(keys)).not.toMatch(
      /203\.0\.113|198\.51\.100|2001:db8|0198f260|search\.|unknown/u,
    );
    await client.del(...keys);
  });
});
