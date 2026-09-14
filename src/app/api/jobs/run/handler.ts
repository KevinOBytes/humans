import { createHash, timingSafeEqual } from "node:crypto";
import { directRouteErrorResponse } from "@/lib/api/direct-route-error";
import { createMethodBoundary } from "@/lib/api/method-boundary";
import { requestCorrelationId } from "@/lib/api/request-id";

import type { JobRunSummary } from "@/worker/run-once";

export const runtime = "nodejs";
export const maxDuration = 30;

type JobsRunRouteDependencies = {
  bootstrap?: () => Promise<void>;
  getSecret(): string | undefined;
  run(): Promise<JobRunSummary>;
};

function json(body: object, status: number, correlationId: string): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
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
    const correlationId = requestCorrelationId(request);
    let secret: string | undefined;
    try {
      secret = input.getSecret();
    } catch {
      return directRouteErrorResponse({
        code: "INTERNAL",
        extra: { success: false },
        requestId: correlationId,
        status: 503,
      });
    }
    if (!isAuthorized(request, secret)) {
      return directRouteErrorResponse({
        code: "UNAUTHENTICATED",
        extra: { success: false },
        requestId: correlationId,
        status: 401,
      });
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
      return directRouteErrorResponse({
        code: "INTERNAL",
        extra: { success: false },
        requestId: correlationId,
        status: 503,
      });
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

export const POST = createMethodBoundary(["GET", "HEAD", "OPTIONS"]).deny;
