import { z } from "zod";

import {
  directRouteErrorResponse,
  type DirectRouteErrorCode,
} from "@/lib/api/direct-route-error";
import { requestCorrelationId } from "@/lib/api/request-id";
import {
  INVITATION_HANDOFF_COOKIE,
  openInvitationHandoff,
  readCookieValue,
  sealInvitationHandoff,
} from "@/modules/auth/invitation-handoff";

type Dependencies = {
  encryptionKey: string;
  getSession(headers: Headers): Promise<unknown | null>;
  secureCookies: boolean;
  trustedOrigins: readonly string[];
};

const bodySchema = z.object({ invitationId: z.uuid() }).strict();

function trusted(request: Request, origins: readonly string[]) {
  const raw = request.headers.get("origin");
  if (!raw || request.headers.get("sec-fetch-site") === "cross-site")
    return false;
  try {
    return origins.some(
      (value) => new URL(value).origin === new URL(raw).origin,
    );
  } catch {
    return false;
  }
}

function cookie(value: string, secure: boolean, maxAge: number) {
  return `${INVITATION_HANDOFF_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function response(
  body: object,
  status: number,
  correlationId: string,
  setCookie?: string,
) {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "x-request-id": correlationId,
  });
  if (setCookie) headers.set("set-cookie", setCookie);
  return Response.json(body, { status, headers });
}

function error(
  code: Extract<
    DirectRouteErrorCode,
    "FORBIDDEN" | "INVALID_INPUT" | "INVITATION_UNAVAILABLE" | "UNAUTHORIZED"
  >,
  status: number,
  correlationId: string,
  setCookie?: string,
): Response {
  return directRouteErrorResponse({
    code,
    headers: setCookie ? { "set-cookie": setCookie } : undefined,
    requestId: correlationId,
    status,
  });
}

export function createInvitationHandoffHandlers(dependencies: Dependencies) {
  return {
    async POST(request: Request) {
      const correlationId = requestCorrelationId(request);
      if (
        request.headers.has("authorization") ||
        request.headers.has("x-api-key") ||
        !trusted(request, dependencies.trustedOrigins)
      ) {
        return error("FORBIDDEN", 403, correlationId);
      }
      const parsed = bodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) return error("INVALID_INPUT", 400, correlationId);
      const token = sealInvitationHandoff({
        encryptionKey: dependencies.encryptionKey,
        invitationId: parsed.data.invitationId,
      });
      return response(
        { status: true, requestId: correlationId },
        200,
        correlationId,
        cookie(token, dependencies.secureCookies, 15 * 60),
      );
    },
    async GET(request: Request) {
      const correlationId = requestCorrelationId(request);
      if (
        request.headers.has("authorization") ||
        request.headers.has("x-api-key")
      )
        return error("FORBIDDEN", 403, correlationId);
      const session = await dependencies
        .getSession(request.headers)
        .catch(() => null);
      if (!session) return error("UNAUTHORIZED", 401, correlationId);
      try {
        const token = readCookieValue(
          request.headers,
          INVITATION_HANDOFF_COOKIE,
        );
        if (!token) throw new Error("missing");
        const invitationId = openInvitationHandoff({
          encryptionKey: dependencies.encryptionKey,
          token,
        });
        return response(
          { invitationId, requestId: correlationId },
          200,
          correlationId,
        );
      } catch {
        return error(
          "INVITATION_UNAVAILABLE",
          404,
          correlationId,
          cookie("", dependencies.secureCookies, 0),
        );
      }
    },
    async DELETE(request: Request) {
      const correlationId = requestCorrelationId(request);
      if (
        request.headers.has("authorization") ||
        request.headers.has("x-api-key") ||
        !trusted(request, dependencies.trustedOrigins)
      )
        return error("FORBIDDEN", 403, correlationId);
      return response(
        { status: true, requestId: correlationId },
        200,
        correlationId,
        cookie("", dependencies.secureCookies, 0),
      );
    },
  };
}

type HandoffHandlers = ReturnType<typeof createInvitationHandoffHandlers>;
type HandoffMethod = keyof HandoffHandlers;

async function loadProductionHandlers() {
  return Promise.all([
    import("@/lib/env/server"),
    import("@/modules/auth/auth"),
  ]).then(([{ getServerEnv }, { auth }]) => {
    const env = getServerEnv();
    return createInvitationHandoffHandlers({
      encryptionKey: env.AUTH_ENCRYPTION_KEY,
      getSession: (headers) => auth.api.getSession({ headers }),
      secureCookies: env.AUTH_SECURE_COOKIES,
      trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    });
  });
}

export function createInvitationHandoffRoute(
  method: HandoffMethod,
  loader: () => Promise<HandoffHandlers> = loadProductionHandlers,
) {
  let pending: Promise<HandoffHandlers> | undefined;
  return async (request: Request): Promise<Response> => {
    const correlationId = requestCorrelationId(request);
    try {
      if (!pending) {
        const current = Promise.resolve().then(loader);
        pending = current;
        void current.catch(() => {
          if (pending === current) pending = undefined;
        });
      }
      return await (await pending)[method](request);
    } catch {
      return error("INVITATION_UNAVAILABLE", 503, correlationId);
    }
  };
}

export const POST = createInvitationHandoffRoute("POST");
export const GET = createInvitationHandoffRoute("GET");
export const DELETE = createInvitationHandoffRoute("DELETE");
