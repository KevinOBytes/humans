import { readFile } from "node:fs/promises";

const path = "/tmp/humans-worker/heartbeat";
const maxAgeMs = 40_000;

try {
  const source = await readFile(path, "utf8");
  if (source.length > 64) process.exit(1);
  const value = JSON.parse(source);
  if (
    !Number.isSafeInteger(value.updatedAt) ||
    Object.keys(value).length !== 1 ||
    value.updatedAt > Date.now() ||
    Date.now() - value.updatedAt > maxAgeMs
  ) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
