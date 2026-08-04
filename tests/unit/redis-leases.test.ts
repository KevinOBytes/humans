import type { Redis as UpstashClient } from "@upstash/redis";
import type IORedis from "ioredis";
import { describe, expect, it } from "vitest";

import {
  LocalRedisStore,
  UpstashRedisStore,
  type RedisStore,
} from "@/lib/redis";

interface LeaseRecord {
  token: string;
  expiresAt: number;
}

class LeaseEngine {
  now = 0;
  readonly records = new Map<string, LeaseRecord>();

  active(key: string): LeaseRecord | undefined {
    const record = this.records.get(key);
    if (record && record.expiresAt <= this.now) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  acquire(key: string, token: string, ttlMs: number): "OK" | null {
    if (this.active(key)) return null;
    this.records.set(key, { token, expiresAt: this.now + ttlMs });
    return "OK";
  }

  extend(key: string, token: string, ttlMs: number): number {
    const record = this.active(key);
    if (!record || record.token !== token) return 0;
    record.expiresAt = this.now + ttlMs;
    return 1;
  }

  release(key: string, token: string): number {
    const record = this.active(key);
    if (!record || record.token !== token) return 0;
    this.records.delete(key);
    return 1;
  }
}

class FakeLocalRedis {
  readonly evalScripts: string[] = [];

  constructor(readonly engine: LeaseEngine) {}

  async set(
    key: string,
    token: string,
    _px: string,
    ttlMs: number,
    _nx: string,
  ): Promise<"OK" | null> {
    if (_px !== "PX" || _nx !== "NX") {
      throw new Error("lease acquisition must use PX and NX");
    }
    return this.engine.acquire(key, token, ttlMs);
  }

  async eval(
    script: string,
    _keyCount: number,
    key: string,
    token: string,
    ttlMs?: number,
  ): Promise<number> {
    this.evalScripts.push(script);
    return ttlMs === undefined
      ? this.engine.release(key, token)
      : this.engine.extend(key, token, ttlMs);
  }
}

class FakeUpstashRedis {
  readonly evalScripts: string[] = [];

  constructor(readonly engine: LeaseEngine) {}

  async set(
    key: string,
    token: string,
    options: { px: number; nx: true },
  ): Promise<"OK" | null> {
    return this.engine.acquire(key, token, options.px);
  }

  async eval(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<string> {
    this.evalScripts.push(script);
    const result =
      args.length === 1
        ? this.engine.release(keys[0], String(args[0]))
        : this.engine.extend(keys[0], String(args[0]), Number(args[1]));
    return String(result);
  }
}

function adapters(): Array<{
  name: string;
  engine: LeaseEngine;
  store: RedisStore;
  scripts: string[];
}> {
  const localEngine = new LeaseEngine();
  const local = new FakeLocalRedis(localEngine);
  const upstashEngine = new LeaseEngine();
  const upstash = new FakeUpstashRedis(upstashEngine);

  return [
    {
      name: "local",
      engine: localEngine,
      store: new LocalRedisStore(local as unknown as IORedis),
      scripts: local.evalScripts,
    },
    {
      name: "upstash",
      engine: upstashEngine,
      store: new UpstashRedisStore(upstash as unknown as UpstashClient),
      scripts: upstash.evalScripts,
    },
  ];
}

describe.each(adapters())(
  "$name Redis leases",
  ({ engine, store, scripts }) => {
    it("rejects wrong-token mutation and invokes compare-token Lua", async () => {
      expect(await store.acquireLease("job:1", "owner", 100)).toBe(true);
      const originalExpiry = engine.active("job:1")?.expiresAt;

      expect(await store.extendLease("job:1", "intruder", 500)).toBe(false);
      expect(engine.active("job:1")).toEqual({
        token: "owner",
        expiresAt: originalExpiry,
      });
      expect(await store.releaseLease("job:1", "intruder")).toBe(false);
      expect(engine.active("job:1")?.token).toBe("owner");

      expect(scripts.some((script) => script.includes("pexpire"))).toBe(true);
      expect(
        scripts.some((script) => script.includes('redis.call("del"')),
      ).toBe(true);
    });

    it("normalizes successful ownership results", async () => {
      expect(await store.acquireLease("job:2", "owner", 100)).toBe(true);
      expect(await store.extendLease("job:2", "owner", 200)).toBe(true);
      expect(engine.active("job:2")?.expiresAt).toBe(200);
      expect(await store.releaseLease("job:2", "owner")).toBe(true);
      expect(engine.active("job:2")).toBeUndefined();
    });

    it("allows reacquisition after expiry", async () => {
      expect(await store.acquireLease("job:3", "first", 100)).toBe(true);
      expect(await store.acquireLease("job:3", "second", 100)).toBe(false);

      engine.now = 101;

      expect(await store.acquireLease("job:3", "second", 100)).toBe(true);
      expect(engine.active("job:3")?.token).toBe("second");
    });
  },
);
