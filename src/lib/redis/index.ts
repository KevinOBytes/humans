import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";

import type { ServerEnv } from "@/lib/env/server-schema";
import type {
  RedisSetOptions,
  RedisStore,
  TokenBucketInput,
  TokenBucketResult,
} from "@/lib/redis/types";

const TOKEN_MICRO_SCALE = 1_000_000;
const MAX_BUCKET_TOKEN_VALUE = 1_000_000;
const MAX_BUCKET_INTERVAL_MS = 86_400_000;
const MAX_BUCKET_TTL_MS = 604_800_000;

export const redisTokenBucketScript = `
local scale = 1000000
local capacity = tonumber(ARGV[1]) * scale
local cost = tonumber(ARGV[2]) * scale
local refill = tonumber(ARGV[3]) * scale
local interval = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local now = redis.call("TIME")
local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
local state = redis.call("HMGET", KEYS[1], "tokens", "updated_at_ms", "refill_remainder")
local tokens = state[1] and tonumber(state[1]) or capacity
local updated_at_ms = state[2] and tonumber(state[2]) or now_ms
local remainder = state[3] and tonumber(state[3]) or 0

if not tokens or not updated_at_ms or not remainder or tokens < 0 or remainder < 0 then
  return redis.error_reply("invalid token bucket state")
end

if tokens > capacity then
  tokens = capacity
end
if remainder >= interval then
  remainder = 0
end

local elapsed = now_ms - updated_at_ms
if elapsed > 0 and tokens < capacity then
  local complete_intervals = math.floor(elapsed / interval)
  local partial_ms = elapsed % interval
  local refill_capacity = capacity - tokens

  if complete_intervals >= math.ceil(refill_capacity / refill) then
    tokens = capacity
    remainder = 0
  else
    tokens = tokens + (complete_intervals * refill)
    local refill_per_ms = math.floor(refill / interval)
    local refill_modulus = refill % interval
    local numerator = (partial_ms * refill_modulus) + remainder
    local partial_refill = (partial_ms * refill_per_ms) + math.floor(numerator / interval)
    remainder = numerator % interval
    tokens = tokens + partial_refill
    if tokens >= capacity then
      tokens = capacity
      remainder = 0
    end
  end
end

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

local stored_at_ms = now_ms
if updated_at_ms > now_ms then
  stored_at_ms = updated_at_ms
end
redis.call("HSET", KEYS[1], "tokens", tostring(math.floor(tokens)), "updated_at_ms", tostring(stored_at_ms), "refill_remainder", tostring(math.floor(remainder)))
redis.call("PEXPIRE", KEYS[1], ttl)
return { allowed, tostring(math.floor(tokens)) }
`;

function assertBoundedInteger(
  name: string,
  value: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Invalid token bucket ${name}.`);
  }
}

function validateTokenBucketInput(input: TokenBucketInput): void {
  if (!input.key || input.key.length > 512) {
    throw new TypeError("Invalid token bucket key.");
  }
  assertBoundedInteger("capacity", input.capacity, MAX_BUCKET_TOKEN_VALUE);
  assertBoundedInteger("cost", input.cost, MAX_BUCKET_TOKEN_VALUE);
  assertBoundedInteger(
    "refill amount",
    input.refillAmount,
    MAX_BUCKET_TOKEN_VALUE,
  );
  assertBoundedInteger(
    "refill interval",
    input.refillIntervalMs,
    MAX_BUCKET_INTERVAL_MS,
  );
  assertBoundedInteger("TTL", input.ttlMs, MAX_BUCKET_TTL_MS);
  if (input.cost > input.capacity) {
    throw new TypeError("Invalid token bucket cost.");
  }
  const fullRefillMs =
    Math.ceil(input.capacity / input.refillAmount) * input.refillIntervalMs;
  if (input.ttlMs < fullRefillMs) {
    throw new TypeError("Invalid token bucket TTL.");
  }
}

function normalizeRedisInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeTokenBucketResult(
  input: TokenBucketInput,
  value: unknown,
): TokenBucketResult {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("Invalid token bucket result.");
  }
  const allowed = normalizeRedisInteger(value[0]);
  const remainingMicrotokens = normalizeRedisInteger(value[1]);
  const maximumMicrotokens = input.capacity * TOKEN_MICRO_SCALE;
  const costMicrotokens = input.cost * TOKEN_MICRO_SCALE;
  if (
    (allowed !== 0 && allowed !== 1) ||
    remainingMicrotokens === null ||
    remainingMicrotokens > maximumMicrotokens ||
    (allowed === 0 && remainingMicrotokens >= costMicrotokens) ||
    (allowed === 1 &&
      remainingMicrotokens > maximumMicrotokens - costMicrotokens)
  ) {
    throw new TypeError("Invalid token bucket result.");
  }

  const retryAfterMs = allowed
    ? 0
    : Math.ceil(
        ((costMicrotokens - remainingMicrotokens) /
          (input.refillAmount * TOKEN_MICRO_SCALE)) *
          input.refillIntervalMs,
      );
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new TypeError("Invalid token bucket result.");
  }
  return {
    allowed: allowed === 1,
    remainingMicrotokens,
    retryAfterMs,
  };
}

export const redisLeaseScripts = Object.freeze({
  extend: `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`,
  release: `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`,
});

export class LocalRedisStore implements RedisStore {
  constructor(private readonly client: IORedis) {}

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<void> {
    if (options?.expiresInMs !== undefined) {
      await this.client.set(key, value, "PX", options.expiresInMs);
      return;
    }
    await this.client.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  increment(key: string, amount = 1): Promise<number> {
    return this.client.incrby(key, amount);
  }

  async acquireLease(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (await this.client.set(key, token, "PX", ttlMs, "NX")) === "OK";
  }

  async extendLease(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(redisLeaseScripts.extend, 1, key, token, ttlMs),
      ) === 1
    );
  }

  async releaseLease(key: string, token: string): Promise<boolean> {
    return (
      Number(
        await this.client.eval(redisLeaseScripts.release, 1, key, token),
      ) === 1
    );
  }

  async consumeTokenBucket(
    input: TokenBucketInput,
  ): Promise<TokenBucketResult> {
    validateTokenBucketInput(input);
    const result = await this.client.eval(
      redisTokenBucketScript,
      1,
      input.key,
      input.capacity,
      input.cost,
      input.refillAmount,
      input.refillIntervalMs,
      input.ttlMs,
    );
    return normalizeTokenBucketResult(input, result);
  }
}

export class UpstashRedisStore implements RedisStore {
  constructor(private readonly client: UpstashRedis) {}

  get(key: string): Promise<string | null> {
    return this.client.get<string>(key);
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions,
  ): Promise<void> {
    await this.client.set(
      key,
      value,
      options?.expiresInMs === undefined
        ? undefined
        : { px: options.expiresInMs },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  increment(key: string, amount = 1): Promise<number> {
    return this.client.incrby(key, amount);
  }

  async acquireLease(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      (await this.client.set(key, token, { px: ttlMs, nx: true })) === "OK"
    );
  }

  async extendLease(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    return (
      Number(
        await this.client.eval(redisLeaseScripts.extend, [key], [token, ttlMs]),
      ) === 1
    );
  }

  async releaseLease(key: string, token: string): Promise<boolean> {
    return (
      Number(
        await this.client.eval(redisLeaseScripts.release, [key], [token]),
      ) === 1
    );
  }

  async consumeTokenBucket(
    input: TokenBucketInput,
  ): Promise<TokenBucketResult> {
    validateTokenBucketInput(input);
    const result = await this.client.eval(
      redisTokenBucketScript,
      [input.key],
      [
        input.capacity,
        input.cost,
        input.refillAmount,
        input.refillIntervalMs,
        input.ttlMs,
      ],
    );
    return normalizeTokenBucketResult(input, result);
  }
}

export type RedisConnectionConfig =
  | { provider: "local"; url: string }
  | { provider: "upstash"; url: string; token: string };

export function redisConnectionConfig(input: {
  url: string;
  token?: string;
}): RedisConnectionConfig {
  if (!input.token) return { provider: "local", url: input.url };

  const url = new URL(input.url);
  return {
    provider: "upstash",
    url: `https://${url.hostname}`,
    token: input.token,
  };
}

export function createRedisStore(env: ServerEnv): RedisStore {
  const config = redisConnectionConfig({
    url: env.REDIS_URL,
    token: env.REDIS_TOKEN,
  });
  if (config.provider === "upstash") {
    return new UpstashRedisStore(
      new UpstashRedis({
        url: config.url,
        token: config.token,
      }),
    );
  }

  return new LocalRedisStore(
    new IORedis(config.url, {
      connectTimeout: 5_000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    }),
  );
}

export type {
  RedisSetOptions,
  RedisStore,
  TokenBucketInput,
  TokenBucketResult,
} from "@/lib/redis/types";
