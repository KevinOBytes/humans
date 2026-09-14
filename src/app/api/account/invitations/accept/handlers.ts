import { z } from "zod";

import { directRouteErrorResponse } from "@/lib/api/direct-route-error";
import { requestCorrelationId } from "@/lib/api/request-id";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  noopSecurityEventLogger,
  type SecurityEventLogger,
} from "@/lib/observability/security-events";
import {
  acceptInvitationAtomically,
  InvitationLifecycleError,
} from "@/modules/auth/invitation-lifecycle";
import { INVITATION_HANDOFF_COOKIE } from "@/modules/auth/invitation-handoff";

const inputSchema = z
  .object({ invitationId: z.string().min(1).max(255) })
  .strict();
type Session = { user: { id: string } } | null;
type Dependencies = {
  accept?: typeof acceptInvitationAtomically;
  database: Database;
  getSession(headers: Headers): Promise<Session>;
  securityLogger?: SecurityEventLogger;
  trustedOrigins: readonly string[];
};

function json(
  body: object,
  status: number,
  requestId: string,
  clearHandoff = false,
): Response {
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    "x-request-id": requestId,
  };
  if (clearHandoff) {
    headers["set-cookie"] =
      `${INVITATION_HANDOFF_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
  return Response.json(body, {
    status,
    headers,
  });
}

function error(
  code:
    "FORBIDDEN" | "INVALID_INPUT" | "INVITATION_UNAVAILABLE" | "UNAUTHORIZED",
  status: number,
  requestId: string,
  clearHandoff = false,
): Response {
  const headers = clearHandoff
    ? {
        "set-cookie": `${INVITATION_HANDOFF_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      }
    : undefined;
  return directRouteErrorResponse({ code, headers, requestId, status });
}

function trustedOrigin(request: Request, origins: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
  )
    return false;
  try {
    return origins.some(
      (candidate) => new URL(candidate).origin === new URL(origin).origin,
    );
  } catch {
    return false;
  }
}

export function createInvitationAcceptanceHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = requestCorrelationId(request);
    if (
      request.headers.has("authorization") ||
      request.headers.has("x-api-key") ||
      !trustedOrigin(request, dependencies.trustedOrigins)
    ) {
      return error("FORBIDDEN", 403, requestId);
    }
    let session: Session;
    try {
      session = await dependencies.getSession(request.headers);
    } catch {
      return error("INVITATION_UNAVAILABLE", 503, requestId);
    }
    if (!session) return error("UNAUTHORIZED", 401, requestId);
    const parsed = inputSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) return error("INVALID_INPUT", 400, requestId);
    try {
      const result = await (dependencies.accept ?? acceptInvitationAtomically)({
        database: dependencies.database,
        invitationId: parsed.data.invitationId,
        userId: session.user.id,
      });
      return json({ result, status: true }, 200, requestId, true);
    } catch (caught) {
      if (caught instanceof InvitationLifecycleError) {
        (dependencies.securityLogger ?? noopSecurityEventLogger).log({
          event: "auth.invitation.acceptance_rejected",
          reason: caught.code,
          requestId,
          severity: "warn",
        });
        return error("INVITATION_UNAVAILABLE", 409, requestId, true);
      }
      return error("INVITATION_UNAVAILABLE", 503, requestId, true);
    }
  };
}

async function getProductionHandler() {
  return Promise.all([
    import("@/db/client"),
    import("@/lib/env/server"),
    import("@/modules/auth/auth"),
    import("@/lib/observability/security-events"),
  ]).then(
    ([
      { db },
      { getServerEnv },
      { auth },
      { productionSecurityEventLogger },
    ]) => {
      const env = getServerEnv();
      return createInvitationAcceptanceHandler({
        database: db,
        getSession: (headers) => auth.api.getSession({ headers }),
        securityLogger: productionSecurityEventLogger,
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

export function createInvitationAcceptanceRoute(
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
      return error("INVITATION_UNAVAILABLE", 503, correlationId);
    }
  };
}

const productionRoute = createInvitationAcceptanceRoute(getProductionHandler);
