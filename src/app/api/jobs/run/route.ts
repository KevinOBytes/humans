import { createHash, timingSafeEqual } from "node:crypto";

import type { JobRunSummary } from "@/worker/run-once";

export const runtime = "nodejs";
export const maxDuration = 30;

type JobsRunRouteDependencies = {
  getSecret(): string | undefined;
  run(): Promise<JobRunSummary>;
};

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return timingSafeEqual(
    createHash("sha256").update(provided, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}

export function createJobsRunHandler(input: JobsRunRouteDependencies) {
  return async (request: Request): Promise<Response> => {
    let secret: string | undefined;
    try {
      secret = input.getSecret();
    } catch {
      return json({ success: false }, 503);
    }
    if (!isAuthorized(request, secret)) {
      return json({ success: false }, 401);
    }
    try {
      const summary = await input.run();
      return json({ success: true, summary }, 200);
    } catch {
      return json({ success: false }, 503);
    }
  };
}

let defaultRunner: (() => Promise<JobRunSummary>) | undefined;

async function runDefaultBatch(): Promise<JobRunSummary> {
  if (!defaultRunner) {
    const [databaseModule, environmentModule, worker] = await Promise.all([
      import("@/db/client"),
      import("@/lib/env/server"),
      import("@/worker/runtime"),
    ]);
    defaultRunner = worker.createRuntimeJobRunner({
      database: databaseModule.db,
      env: environmentModule.getServerEnv(),
    });
  }
  return defaultRunner();
}

export const GET = createJobsRunHandler({
  getSecret: () => process.env.CRON_SECRET,
  run: runDefaultBatch,
});

export function POST(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      allow: "GET",
      "cache-control": "no-store",
    },
  });
}
