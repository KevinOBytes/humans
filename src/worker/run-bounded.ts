import { db } from "@/db/client";
import { getServerEnv } from "@/lib/env/server";
import { createRuntimeJobRunner } from "@/worker/runtime";

export async function runBoundedJobs(): Promise<void> {
  const runOnce = createRuntimeJobRunner({
    database: db,
    env: getServerEnv(),
  });
  await runOnce();
}

if (process.argv[1]?.endsWith("run-bounded.ts")) {
  void runBoundedJobs().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
