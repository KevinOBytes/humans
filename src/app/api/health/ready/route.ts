import postgres from "postgres";

import { getServerEnv } from "@/lib/env/server";
import { createRedisStore, type RedisStore } from "@/lib/redis";
import { createObjectStore } from "@/lib/storage/s3";
import type { ObjectStore } from "@/lib/storage/types";

export interface ReadinessProbe {
  name: string;
  check(): Promise<void>;
}

export interface ReadinessOptions {
  timeoutMs?: number;
}

async function checkBeforeDeadline(
  check: () => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const checkResult = Promise.resolve()
    .then(check)
    .then(
      () => true,
      () => false,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });

  try {
    return await Promise.race([checkResult, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createReadinessHandler(
  probes: readonly ReadinessProbe[],
  options: ReadinessOptions = {},
): () => Promise<Response> {
  return async () => {
    const results = await Promise.all(
      probes.map(({ check }) =>
        checkBeforeDeadline(check, options.timeoutMs ?? 2_500),
      ),
    );
    const dependencies = Object.fromEntries(
      probes.map((probe, index) => [
        probe.name,
        results[index] ? "ok" : "failed",
      ]),
    );
    const ready = results.every(Boolean);

    return Response.json(
      {
        status: ready ? "ready" : "unavailable",
        service: "humans",
        dependencies,
      },
      { status: ready ? 200 : 503 },
    );
  };
}

let redisStore: RedisStore | undefined;
let objectStore: ObjectStore | undefined;

function getRedisStore(): RedisStore {
  redisStore ??= createRedisStore(getServerEnv());
  return redisStore;
}

function getObjectStore(): ObjectStore {
  objectStore ??= createObjectStore(getServerEnv());
  return objectStore;
}

const defaultProbes: readonly ReadinessProbe[] = [
  {
    name: "configuration",
    check: async () => {
      getServerEnv();
    },
  },
  {
    name: "postgres",
    check: async () => {
      const env = getServerEnv();
      const sql = postgres(env.DATABASE_URL, {
        connect_timeout: 5,
        idle_timeout: 1,
        max: 1,
      });
      try {
        await sql`select 1`;
      } finally {
        await sql.end({ timeout: 1 });
      }
    },
  },
  {
    name: "redis",
    check: async () => {
      await getRedisStore().get("__humans:health:ready");
    },
  },
  {
    name: "storage",
    check: async () => {
      await getObjectStore().checkReachability();
    },
  },
];

export const GET = createReadinessHandler(defaultProbes);
