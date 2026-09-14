import { z } from "zod";

import { directRouteErrorResponse } from "@/lib/api/direct-route-error";
import { requestCorrelationId } from "@/lib/api/request-id";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  changeTwoFactorStateAtomically,
  TwoFactorLifecycleError,
} from "@/modules/auth/two-factor-lifecycle";

const bodySchema = z
  .object({
    action: z.enum(["cancel", "disable"]),
    password: z.string().min(1).max(1_024),
  })
  .strict();

type Session = { user: { id: string } } | null;

type Dependencies = {
  change?: typeof changeTwoFactorStateAtomically;
  consumeAttempt?: (input: {
    request: Request;
    userId: string;
  }) => Promise<boolean>;
  database: Database;
  getSession(headers: Headers): Promise<Session>;
  trustedOrigins: readonly string[];
};

function response(body: object, status: number, requestId: string): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-request-id": requestId,
    },
  });
}

function trustedOrigin(request: Request, origins: readonly string[]): boolean {
  const raw = request.headers.get("origin");
  if (
    !raw ||
    request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
  ) {
    return false;
  }
  try {
    return origins.some(
      (candidate) => new URL(candidate).origin === new URL(raw).origin,
    );
  } catch {
    return false;
  }
}

function error(
  code:
    | "FORBIDDEN"
    | "INVALID_INPUT"
    | "SECURITY_CHANGE_REJECTED"
    | "SECURITY_CHANGE_UNAVAILABLE"
    | "UNAUTHORIZED",
  status: number,
  requestId: string,
): Response {
  return directRouteErrorResponse({ code, requestId, status });
}

export function createTwoFactorDisableHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const correlationId = requestCorrelationId(request);
    if (
      request.headers.has("authorization") ||
      request.headers.has("x-api-key") ||
      !trustedOrigin(request, dependencies.trustedOrigins)
    ) {
      return error("FORBIDDEN", 403, correlationId);
    }
    let session: Session;
    try {
      session = await dependencies.getSession(request.headers);
    } catch {
      return error("SECURITY_CHANGE_UNAVAILABLE", 503, correlationId);
    }
    if (!session) {
      return error("UNAUTHORIZED", 401, correlationId);
    }
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json());
    } catch {
      return error("INVALID_INPUT", 400, correlationId);
    }
    let attemptAllowed = true;
    try {
      attemptAllowed =
        !dependencies.consumeAttempt ||
        (await dependencies.consumeAttempt({
          request,
          userId: session.user.id,
        }));
    } catch {
      return error("SECURITY_CHANGE_UNAVAILABLE", 503, correlationId);
    }
    if (!attemptAllowed) {
      return error("SECURITY_CHANGE_REJECTED", 400, correlationId);
    }
    try {
      const result = await (
        dependencies.change ?? changeTwoFactorStateAtomically
      )({
        action: body.action,
        database: dependencies.database,
        password: body.password,
        userId: session.user.id,
      });
      return response({ status: true, result }, 200, correlationId);
    } catch (caught) {
      if (caught instanceof TwoFactorLifecycleError) {
        const status = caught.code === "CONFLICT" ? 409 : 400;
        return error("SECURITY_CHANGE_REJECTED", status, correlationId);
      }
      return error("SECURITY_CHANGE_UNAVAILABLE", 503, correlationId);
    }
  };
}

async function getProductionHandler() {
  return Promise.all([
    import("@/db/client"),
    import("@/lib/env/server"),
    import("@/modules/auth/auth"),
    import("@/modules/auth/password-attempt-limiter"),
    import("@/modules/auth/request-boundary"),
  ]).then(
    ([
      { db },
      { getServerEnv },
      { auth },
      { consumePasswordAttempt },
      { resolveAuthClientAddress },
    ]) => {
      const env = getServerEnv();
      const clientAddressConfig =
        env.TRUSTED_PROXY_MODE === "hmac"
          ? {
              deploymentMode: "docker" as const,
              hmacKey: env.TRUSTED_PROXY_HMAC_KEY!,
              mode: "hmac" as const,
            }
          : env.TRUSTED_PROXY_MODE === "vercel"
            ? {
                deploymentMode: "vercel" as const,
                mode: "vercel" as const,
              }
            : {
                deploymentMode: env.DEPLOYMENT_MODE,
                mode: "none" as const,
              };
      return createTwoFactorDisableHandler({
        consumeAttempt: async ({ request, userId }) =>
          consumePasswordAttempt({
            clientAddress: await resolveAuthClientAddress(request, {
              authSecret: env.AUTH_SECRET,
              clientAddressConfig,
            }),
            database: db,
            operation: "two-factor-state-change",
            secret: env.AUTH_SECRET,
            userId,
          }),
        database: db,
        getSession: (headers) => auth.api.getSession({ headers }),
        trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
      });
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  return productionRoute(request);
}

type Handler = (request: Request) => Promise<Response>;
type InfrastructureLogger = {
  log(event: {
    event: "auth.infrastructure.failure";
    requestId: string;
    severity: "error";
  }): void;
};

const fallbackInfrastructureLogger: InfrastructureLogger = {
  log: (event) => console.error(event),
};

export function createTwoFactorDisableRoute(
  loader: () => Promise<Handler>,
  infrastructureLogger: InfrastructureLogger = fallbackInfrastructureLogger,
) {
  let pending: Promise<Handler> | undefined;
  // Concurrent callers share initialization. Only a rejected initialization is
  // evicted; a constructed handler remains cached across request-level failures.
  const load = (): Promise<Handler> => {
    if (!pending) {
      const current = Promise.resolve().then(loader);
      pending = current;
      void current.catch(() => {
        if (pending === current) pending = undefined;
      });
    }
    return pending;
  };
  return async (request: Request): Promise<Response> => {
    const correlationId = requestCorrelationId(request);
    try {
      return await (
        await load()
      )(request);
    } catch {
      infrastructureLogger.log({
        event: "auth.infrastructure.failure",
        requestId: correlationId,
        severity: "error",
      });
      return error("SECURITY_CHANGE_UNAVAILABLE", 503, correlationId);
    }
  };
}

const productionRoute = createTwoFactorDisableRoute(getProductionHandler);
