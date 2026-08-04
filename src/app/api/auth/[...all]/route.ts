type AuthMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type AuthHandler = (request: Request) => Promise<Response>;
type AuthRouteHandlers = Record<AuthMethod, AuthHandler>;
type AuthHandlerLoader = () => Promise<
  Partial<Record<AuthMethod, (request: Request) => Promise<Response>>>
>;
type InfrastructureLogger = {
  log(event: {
    event: "auth.infrastructure.failure";
    requestId: string;
    severity: "error";
  }): void;
};

const protectedPostPaths = new Set([
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/remove-member",
  "/api/auth/api-key/create",
  "/api/auth/api-key/update",
  "/api/auth/api-key/delete",
]);
const wrappedLifecyclePostPaths = new Set([
  "/api/auth/organization/accept-invitation",
  "/api/auth/two-factor/disable",
]);

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && requestIdPattern.test(candidate)
    ? candidate.toLowerCase()
    : crypto.randomUUID();
}

function boundaryError(
  request: Request,
  body: { code: string; message: string },
  status = 403,
): Response {
  const correlationId = requestId(request);
  return Response.json(
    { ...body, requestId: correlationId },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "x-request-id": correlationId,
      },
    },
  );
}

function infrastructureUnavailable(
  request: Request,
  logger: InfrastructureLogger,
): Response {
  const correlationId = requestId(request);
  logger.log({
    event: "auth.infrastructure.failure",
    requestId: correlationId,
    severity: "error",
  });
  return Response.json(
    {
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Authentication service is temporarily unavailable.",
      requestId: correlationId,
    },
    {
      status: 503,
      headers: {
        "cache-control": "private, no-store",
        "x-request-id": correlationId,
      },
    },
  );
}

const fallbackInfrastructureLogger: InfrastructureLogger = {
  log: (event) => console.error(event),
};

function normalizedPathname(request: Request): string | undefined {
  try {
    const decoded = decodeURIComponent(new URL(request.url).pathname);
    const normalized = decoded.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
    return normalized || "/";
  } catch {
    return undefined;
  }
}

function isProtectedAdministrationRequest(
  method: AuthMethod,
  request: Request,
): boolean {
  if (method !== "POST") return false;
  const pathname = normalizedPathname(request);
  return pathname !== undefined && protectedPostPaths.has(pathname);
}

function administrationDisabledResponse(request: Request): Response {
  return boundaryError(request, {
    code: "AUTH_ADMINISTRATION_DISABLED",
    message: "This administration endpoint is unavailable.",
  });
}

function lifecycleWrapperRequiredResponse(request: Request): Response {
  return boundaryError(request, {
    code: "AUTH_LIFECYCLE_WRAPPER_REQUIRED",
    message: "Use the protected account security endpoint.",
  });
}

let routeHandlers: Promise<AuthRouteHandlers> | undefined;

function getRouteHandlers(): Promise<AuthRouteHandlers> {
  routeHandlers ??= Promise.all([
    import("better-auth/next-js"),
    import("@/lib/env/server"),
    import("@/modules/auth/auth"),
    import("@/modules/auth/request-boundary"),
    import("@/db/client"),
    import("@/lib/email/resend"),
    import("@/lib/observability/security-events"),
    import("@/modules/auth/invite-signup"),
    import("@/modules/auth/email-outbox"),
  ]).then(
    ([
      { toNextJsHandler },
      { getServerEnv },
      { auth, createHumansAuth },
      boundary,
      { db },
      { createEmailSender },
      { productionSecurityEventLogger },
      { createTransactionalInviteSignUpHandler },
      { createAuthEmailOutboxSender, runAuthEmailOutboxOnce },
    ]) => {
      const env = getServerEnv();
      const handlers = toNextJsHandler(auth) as AuthRouteHandlers;
      const emailSender = createEmailSender(env);
      const inviteSignUp = createTransactionalInviteSignUpHandler({
        database: db,
        createHandler: (database) => {
          const outbox = createAuthEmailOutboxSender({
            authSecret: env.AUTH_SECRET,
            database,
            encryptionKey: env.AUTH_ENCRYPTION_KEY,
          });
          const committedEvents: Parameters<
            typeof productionSecurityEventLogger.log
          >[0][] = [];
          const securityLogger = {
            log(
              event: Parameters<typeof productionSecurityEventLogger.log>[0],
            ) {
              if (event.event === "auth.registration.allowed") {
                committedEvents.push(event);
              } else {
                productionSecurityEventLogger.log(event);
              }
            },
          };
          const handler = (
            toNextJsHandler(
              createHumansAuth({
                database,
                emailSender: outbox.sender,
                securityLogger,
                settings: env,
              }),
            ) as AuthRouteHandlers
          ).POST;
          return {
            handler,
            afterCommit: async () => {
              for (const event of committedEvents) {
                productionSecurityEventLogger.log(event);
              }
              if (outbox.queuedIds.length > 0) {
                await runAuthEmailOutboxOnce({
                  database: db,
                  emailSender,
                  encryptionKey: env.AUTH_ENCRYPTION_KEY,
                  ids: outbox.queuedIds,
                });
              }
            },
          };
        },
        onPostCommitFailure: (request) =>
          productionSecurityEventLogger.log({
            event: "auth.infrastructure.failure",
            requestId: request.headers.get(boundary.AUTH_REQUEST_ID_HEADER)!,
            severity: "error",
          }),
      });
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
      return Object.fromEntries(
        Object.entries(handlers).map(([method, handler]) => [
          method,
          async (request: Request) => {
            const prepared = await boundary.prepareAuthBoundaryRequest(
              request,
              {
                authSecret: env.AUTH_SECRET,
                clientAddressConfig,
              },
            );
            const selectedHandler =
              method === "POST" &&
              env.AUTH_REGISTRATION_MODE === "invite_only" &&
              normalizedPathname(prepared) === "/api/auth/sign-up/email"
                ? inviteSignUp
                : handler;
            const response = await selectedHandler(prepared);
            return boundary.decorateAuthBoundaryResponse(
              response,
              prepared.headers.get(boundary.AUTH_REQUEST_ID_HEADER)!,
            );
          },
        ]),
      ) as AuthRouteHandlers;
    },
  );
  return routeHandlers;
}

function lazyAuthHandler(
  method: AuthMethod,
  loadHandlers: AuthHandlerLoader,
  infrastructureLogger: InfrastructureLogger,
) {
  return async (request: Request): Promise<Response> => {
    if (
      request.headers.has("authorization") ||
      request.headers.has("x-api-key")
    ) {
      return boundaryError(request, {
        code: "AUTH_API_KEY_INTERACTIVE_FORBIDDEN",
        message: "API credentials cannot authorize account operations.",
      });
    }
    if (isProtectedAdministrationRequest(method, request)) {
      return administrationDisabledResponse(request);
    }
    if (
      method === "POST" &&
      wrappedLifecyclePostPaths.has(normalizedPathname(request) ?? "")
    ) {
      return lifecycleWrapperRequiredResponse(request);
    }
    try {
      const handlers = await loadHandlers();
      const handler = handlers[method];
      if (!handler) {
        return boundaryError(
          request,
          {
            code: "AUTH_METHOD_NOT_ALLOWED",
            message: "This authentication method is unavailable.",
          },
          405,
        );
      }
      return await handler(request);
    } catch {
      return infrastructureUnavailable(request, infrastructureLogger);
    }
  };
}

export function createAuthRouteHandlers(
  loadHandlers: AuthHandlerLoader,
  infrastructureLogger: InfrastructureLogger = fallbackInfrastructureLogger,
) {
  return {
    GET: lazyAuthHandler("GET", loadHandlers, infrastructureLogger),
    POST: lazyAuthHandler("POST", loadHandlers, infrastructureLogger),
    PATCH: lazyAuthHandler("PATCH", loadHandlers, infrastructureLogger),
    PUT: lazyAuthHandler("PUT", loadHandlers, infrastructureLogger),
    DELETE: lazyAuthHandler("DELETE", loadHandlers, infrastructureLogger),
  };
}

const handlers = createAuthRouteHandlers(getRouteHandlers);

export const { GET, POST, PATCH, PUT, DELETE } = handlers;
