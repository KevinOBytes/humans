import { pathToFileURL } from "node:url";

import { JobExecutionError, MAX_RUN_ONCE_MS } from "@/modules/jobs/types";
import { createWorkerHeartbeat } from "@/worker/heartbeat";

const POLL_MS = 1_000;
const MAX_FAILURE_BACKOFF_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HARD_EXIT_GRACE_MS = 5_000;

declare const __HUMANS_RUNTIME_ENTRY__: string | undefined;

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type WorkerHeartbeat = Readonly<{
  refresh(): Promise<void>;
  remove(): Promise<void>;
}>;

async function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runJobsContinuously(input: {
  hardExit?: (code: 1) => void;
  hardExitGraceMs?: number;
  heartbeat?: WorkerHeartbeat;
  heartbeatIntervalMs?: number;
  passTimeLimitMs?: number;
  runOnce: (input: { signal: AbortSignal }) => Promise<{ claimed: number }>;
  signal?: AbortSignal;
  sleep?: Sleep;
}): Promise<void> {
  const sleep = input.sleep ?? defaultSleep;
  const heartbeatIntervalMs =
    input.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const hardExitGraceMs = input.hardExitGraceMs ?? HARD_EXIT_GRACE_MS;
  const hardExit = input.hardExit ?? ((code: 1) => process.exit(code));
  const passTimeLimitMs = input.passTimeLimitMs ?? MAX_RUN_ONCE_MS;
  let consecutiveFailures = 0;
  try {
    while (!input.signal?.aborted) {
      let waitMs = POLL_MS;
      try {
        const result = await runPass({
          hardExit,
          hardExitGraceMs,
          heartbeat: input.heartbeat,
          heartbeatIntervalMs,
          passTimeLimitMs,
          runOnce: input.runOnce,
          signal: input.signal,
          sleep,
        });
        consecutiveFailures = 0;
        if (result.claimed !== 0) continue;
      } catch (error) {
        if (input.signal?.aborted) return;
        if (error instanceof JobExecutionError && error.code === "time_limit") {
          throw error;
        }
        consecutiveFailures += 1;
        waitMs = Math.min(
          MAX_FAILURE_BACKOFF_MS,
          POLL_MS * 2 ** Math.min(consecutiveFailures - 1, 5),
        );
      }
      if (input.signal?.aborted) return;
      try {
        await sleep(waitMs, input.signal);
      } catch (error) {
        if (input.signal?.aborted) return;
        throw error;
      }
    }
  } finally {
    await input.heartbeat?.remove();
  }
}

async function runPass(input: {
  hardExit: (code: 1) => void;
  hardExitGraceMs: number;
  heartbeat?: WorkerHeartbeat;
  heartbeatIntervalMs: number;
  passTimeLimitMs: number;
  runOnce: (input: { signal: AbortSignal }) => Promise<{ claimed: number }>;
  signal?: AbortSignal;
  sleep: Sleep;
}): Promise<{ claimed: number }> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let hardExitTimer: ReturnType<typeof setTimeout> | undefined;
  const drain = () => {
    if (controller.signal.aborted) return;
    if (deadline) clearTimeout(deadline);
    controller.abort(
      input.signal?.reason instanceof Error
        ? input.signal.reason
        : new JobExecutionError("worker_draining", "retryable"),
    );
  };
  const exceedDeadline = () => {
    controller.abort(new JobExecutionError("time_limit", "retryable"));
    hardExitTimer = setTimeout(() => input.hardExit(1), input.hardExitGraceMs);
  };
  if (input.signal?.aborted) drain();
  else {
    input.signal?.addEventListener("abort", drain, { once: true });
    deadline = setTimeout(exceedDeadline, input.passTimeLimitMs);
  }
  let heartbeatError: unknown;
  const heartbeatController = new AbortController();
  const stopHeartbeat = () => heartbeatController.abort();
  controller.signal.addEventListener("abort", stopHeartbeat, { once: true });
  const heartbeatTask = pulseHeartbeat({
    heartbeat: input.heartbeat,
    intervalMs: input.heartbeatIntervalMs,
    signal: heartbeatController.signal,
    sleep: input.sleep,
  }).catch((error: unknown) => {
    if (!heartbeatController.signal.aborted) {
      heartbeatError = error;
      controller.abort(
        new JobExecutionError("dependency_unavailable", "retryable"),
      );
    }
  });
  try {
    const result = await input.runOnce({ signal: controller.signal });
    if (heartbeatError) throw heartbeatError;
    if (
      controller.signal.reason instanceof JobExecutionError &&
      controller.signal.reason.code === "time_limit"
    ) {
      throw controller.signal.reason;
    }
    return result;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (hardExitTimer) clearTimeout(hardExitTimer);
    input.signal?.removeEventListener("abort", drain);
    controller.signal.removeEventListener("abort", stopHeartbeat);
    stopHeartbeat();
    await heartbeatTask;
  }
}

async function pulseHeartbeat(input: {
  heartbeat?: WorkerHeartbeat;
  intervalMs: number;
  signal: AbortSignal;
  sleep: Sleep;
}): Promise<void> {
  if (!input.heartbeat) return;
  while (!input.signal.aborted) {
    await input.heartbeat.refresh();
    try {
      await input.sleep(input.intervalMs, input.signal);
    } catch (error) {
      if (input.signal.aborted) return;
      throw error;
    }
  }
}

export async function main(): Promise<void> {
  const [{ db }, { getServerEnv }, { createRuntimeJobRunner }] =
    await Promise.all([
      import("@/db/client"),
      import("@/lib/env/server"),
      import("@/worker/runtime"),
    ]);
  const env = getServerEnv();
  const runOnce = createRuntimeJobRunner({
    database: db,
    env,
  });
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await runJobsContinuously({
    heartbeat: createWorkerHeartbeat(),
    signal: controller.signal,
    runOnce,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

const bundledRuntimeEntry =
  typeof __HUMANS_RUNTIME_ENTRY__ === "undefined"
    ? undefined
    : __HUMANS_RUNTIME_ENTRY__;

if (
  invokedPath === import.meta.url &&
  (bundledRuntimeEntry === undefined || bundledRuntimeEntry === "worker.mjs")
) {
  void main().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
