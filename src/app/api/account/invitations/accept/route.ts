import { z } from "zod";

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sanitizeRequestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && requestIdPattern.test(candidate)
    ? candidate.toLowerCase()
    : crypto.randomUUID();
}

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
    const requestId = sanitizeRequestId(request);
    if (
      request.headers.has("authorization") ||
      request.headers.has("x-api-key") ||
      !trustedOrigin(request, dependencies.trustedOrigins)
    ) {
      return json({ code: "FORBIDDEN", requestId }, 403, requestId);
    }
    let session: Session;
    try {
      session = await dependencies.getSession(request.headers);
    } catch {
      return json(
        { code: "INVITATION_UNAVAILABLE", requestId },
        503,
        requestId,
      );
    }
    if (!session)
      return json({ code: "UNAUTHORIZED", requestId }, 401, requestId);
    const parsed = inputSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return json({ code: "INVALID_INPUT", requestId }, 400, requestId);
    try {
      const result = await (dependencies.accept ?? acceptInvitationAtomically)({
        database: dependencies.database,
        invitationId: parsed.data.invitationId,
        userId: session.user.id,
      });
      return json({ result, status: true }, 200, requestId, true);
    } catch (error) {
      if (error instanceof InvitationLifecycleError) {
        (dependencies.securityLogger ?? noopSecurityEventLogger).log({
          event: "auth.invitation.acceptance_rejected",
          reason: error.code,
          requestId,
          severity: "warn",
        });
        return json(
          { code: "INVITATION_UNAVAILABLE", requestId },
          409,
          requestId,
          true,
        );
      }
      return json(
        { code: "INVITATION_UNAVAILABLE", requestId },
        503,
        requestId,
        true,
      );
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
    const correlationId = sanitizeRequestId(request);
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
      return json(
        { code: "INVITATION_UNAVAILABLE", requestId: correlationId },
        503,
        correlationId,
      );
    }
  };
}

const productionRoute = createInvitationAcceptanceRoute(getProductionHandler);
