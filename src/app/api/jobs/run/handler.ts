import { createHash, timingSafeEqual } from "node:crypto";

import type { JobRunSummary } from "@/worker/run-once";

export const runtime = "nodejs";
export const maxDuration = 30;

type JobsRunRouteDependencies = {
  bootstrap?: () => Promise<void>;
  getSecret(): string | undefined;
  run(): Promise<JobRunSummary>;
};

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && requestIdPattern.test(candidate)
    ? candidate.toLowerCase()
    : crypto.randomUUID();
}

function json(body: object, status: number, correlationId: string): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": correlationId,
    },
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
    const correlationId = requestId(request);
    let secret: string | undefined;
    try {
      secret = input.getSecret();
    } catch {
      return json(
        { success: false, code: "INTERNAL", requestId: correlationId },
        503,
        correlationId,
      );
    }
    if (!isAuthorized(request, secret)) {
      return json(
        {
          success: false,
          code: "UNAUTHENTICATED",
          requestId: correlationId,
        },
        401,
        correlationId,
      );
    }
    try {
      await input.bootstrap?.();
      const summary = await input.run();
      return json(
        { success: true, summary, requestId: correlationId },
        200,
        correlationId,
      );
    } catch {
      return json(
        { success: false, code: "INTERNAL", requestId: correlationId },
        503,
        correlationId,
      );
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

async function bootstrapConfiguredAdministrator(): Promise<void> {
  const configured = [
    process.env.ADMIN_EMAIL,
    process.env.ADMIN_USERNAME,
    process.env.ADMIN_DISPLAY_NAME,
    process.env.ADMIN_PASSWORD,
  ].every((value) => Boolean(value?.trim()));
  if (!configured) return;

  const [{ db }, { parseBootstrapAdminEnv }, { bootstrapAdmin }] =
    await Promise.all([
      import("@/db/client"),
      import("@/lib/env/server-schema"),
      import("@/modules/auth/bootstrap-admin"),
    ]);
  await bootstrapAdmin(db, parseBootstrapAdminEnv(process.env));
}

export const GET = createJobsRunHandler({
  bootstrap: bootstrapConfiguredAdministrator,
  getSecret: () => process.env.CRON_SECRET,
  run: runDefaultBatch,
});

export function POST(request: Request): Response {
  const correlationId = requestId(request);
  return new Response(null, {
    status: 405,
    headers: {
      allow: "GET",
      "cache-control": "no-store",
      "x-request-id": correlationId,
    },
  });
}
