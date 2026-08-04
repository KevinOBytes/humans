#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoot = await mkdtemp(join(tmpdir(), "humans-drizzle-drift-"));
const generatedDirectory = join(temporaryRoot, "drizzle");

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

try {
  await cp("drizzle", generatedDirectory, { recursive: true });
  const generate = run("corepack", [
    "pnpm",
    "exec",
    "drizzle-kit",
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    "./src/db/schema/index.ts",
    "--out",
    generatedDirectory,
    "--name",
    "ci-drift",
  ]);
  if (generate.status !== 0) {
    process.stderr.write(generate.stdout);
    process.stderr.write(generate.stderr);
    throw new Error("Drizzle generation failed");
  }

  const comparison = run("git", [
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--",
    "drizzle",
    generatedDirectory,
  ]);
  if (comparison.status === 1) {
    process.stderr.write(comparison.stdout);
    throw new Error(
      "Drizzle migrations are stale; generate and review the required migration",
    );
  }
  if (comparison.status !== 0) {
    process.stderr.write(comparison.stderr);
    throw new Error("Unable to compare generated Drizzle migrations");
  }
  process.stdout.write("Drizzle migration generation is in sync.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
