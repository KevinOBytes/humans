import type { Redis as UpstashClient } from "@upstash/redis";
import type IORedis from "ioredis";
import { describe, expect, it } from "vitest";

import {
  LocalRedisStore,
  UpstashRedisStore,
  redisTokenBucketScript,
  type RedisStore,
  type TokenBucketInput,
} from "@/lib/redis";

const validBucket: TokenBucketInput = {
  capacity: 3,
  cost: 2,
  key: "operation:v1:digest",
  refillAmount: 1,
  refillIntervalMs: 1_000,
  ttlMs: 3_000,
};

class FakeLocalRedis {
  calls: unknown[][] = [];
  result: unknown = [1, "500000"];

  async eval(...args: unknown[]): Promise<unknown> {
    this.calls.push(args);
    return this.result;
  }
}

class FakeUpstashRedis {
  calls: unknown[][] = [];
  result: unknown = ["1", 500_000];

  async eval(...args: unknown[]): Promise<unknown> {
    this.calls.push(args);
    return this.result;
  }
}

function adapters(): Array<{
  client: FakeLocalRedis | FakeUpstashRedis;
  name: string;
  store: RedisStore;
}> {
  const local = new FakeLocalRedis();
  const upstash = new FakeUpstashRedis();
  return [
    {
      client: local,
      name: "local",
      store: new LocalRedisStore(local as unknown as IORedis),
    },
    {
      client: upstash,
      name: "upstash",
      store: new UpstashRedisStore(upstash as unknown as UpstashClient),
    },
  ];
}

describe.each(adapters())(
  "$name Redis token bucket adapter",
  ({ client, name, store }) => {
    it("normalizes an exact weighted boundary from both eval result shapes", async () => {
      const result = await store.consumeTokenBucket(validBucket);

      expect(result).toEqual({
        allowed: true,
        remainingMicrotokens: 500_000,
        retryAfterMs: 0,
      });
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0]?.[0]).toBe(redisTokenBucketScript);
      if (name === "local") {
        expect(client.calls[0]).toEqual([
          redisTokenBucketScript,
          1,
          validBucket.key,
          3,
          2,
          1,
          1_000,
          3_000,
        ]);
      } else {
        expect(client.calls[0]).toEqual([
          redisTokenBucketScript,
          [validBucket.key],
          [3, 2, 1, 1_000, 3_000],
        ]);
      }
    });

    it("derives a bounded retry delay for an exhausted weighted request", async () => {
      client.result = [0, "250000"];

      await expect(store.consumeTokenBucket(validBucket)).resolves.toEqual({
        allowed: false,
        remainingMicrotokens: 250_000,
        retryAfterMs: 1_750,
      });
    });

    it.each([
      ["zero capacity", { capacity: 0 }],
      ["fractional cost", { cost: 0.5 }],
      ["cost above capacity", { cost: 4 }],
      ["zero refill", { refillAmount: 0 }],
      ["unbounded interval", { refillIntervalMs: 86_400_001 }],
      ["premature expiry", { ttlMs: 2_999 }],
      ["oversized key", { key: "x".repeat(513) }],
    ])("rejects %s before invoking Redis", async (_label, override) => {
      const priorCalls = client.calls.length;
      await expect(
        store.consumeTokenBucket({ ...validBucket, ...override }),
      ).rejects.toThrow(/token bucket/iu);
      expect(client.calls).toHaveLength(priorCalls);
    });

    it.each([
      null,
      [],
      [1],
      [2, "0"],
      [1, "-1"],
      [0, "2000000"],
      [1, "1500000"],
      [1, "3000001"],
      [1, "0", "extra"],
    ])("fails closed for malformed eval result %#", async (result) => {
      client.result = result;

      await expect(store.consumeTokenBucket(validBucket)).rejects.toThrow(
        /token bucket result/iu,
      );
    });
  },
);
