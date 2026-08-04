import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const WORKER_HEARTBEAT_PATH = "/tmp/humans-worker/heartbeat";
export const WORKER_HEARTBEAT_MAX_AGE_MS = 40_000;

export function createWorkerHeartbeat(input?: {
  now?: () => number;
  path?: string;
}) {
  const now = input?.now ?? Date.now;
  const path = input?.path ?? WORKER_HEARTBEAT_PATH;
  const temporaryPath = `${path}.tmp`;

  return {
    async refresh(): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const payload = `${JSON.stringify({ updatedAt: now() })}\n`;
      await writeFile(temporaryPath, payload, { mode: 0o600 });
      await rename(temporaryPath, path);
    },
    async remove(): Promise<void> {
      await Promise.all([
        rm(path, { force: true }),
        rm(temporaryPath, { force: true }),
      ]);
    },
  };
}
