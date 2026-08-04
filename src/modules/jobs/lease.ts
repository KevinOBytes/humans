import { createHash } from "node:crypto";

import type { RedisStore } from "@/lib/redis";

import { JOB_LEASE_MS } from "./types";

export function jobLeaseKey(jobId: string): string {
  return `humans:jobs:lease:${createHash("sha256").update(jobId).digest("hex")}`;
}

export function createJobLease(input: {
  jobId: string;
  redis: RedisStore;
  owner: string;
  ttlMs?: number;
}) {
  const ttlMs = input.ttlMs ?? JOB_LEASE_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) {
    throw new TypeError("Invalid job lease duration");
  }
  const key = jobLeaseKey(input.jobId);
  return {
    acquire: () => input.redis.acquireLease(key, input.owner, ttlMs),
    renew: () => input.redis.extendLease(key, input.owner, ttlMs),
    release: () => input.redis.releaseLease(key, input.owner),
  };
}
