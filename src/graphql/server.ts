import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { maxTokensPlugin } from "@escape.tech/graphql-armor-max-tokens";
import { useCSRFPrevention as csrfPreventionPlugin } from "@graphql-yoga/plugin-csrf-prevention";
import { useDisableIntrospection as disableIntrospectionPlugin } from "@graphql-yoga/plugin-disable-introspection";
import {
  GraphQLError,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import {
  createYoga,
  maskError as maskYogaError,
  type Plugin,
} from "graphql-yoga";

import type { BetterAuthRuntime } from "@/lib/auth/config";
import {
  noopSecurityEventLogger,
  type SecurityEventLogger,
} from "@/lib/observability/security-events";
import {
  classifyClientAddress,
  type TrustedProxyConfig,
} from "@/lib/network/client-address";
import type { Database } from "@/modules/auth/bootstrap-admin";
import type { OperationLimiter } from "@/graphql/operation-limiter";
import type { FileServiceRuntime } from "@/modules/files/service";
import type { ImportServiceRuntime } from "@/modules/imports/service";
import type { WorkspaceMemberRuntime } from "@/modules/settings/workspace-members";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
import type { Task12Metrics } from "@/modules/search/metrics";
import type { SearchRuntime } from "@/modules/search/service";
import type { AiAnalysisRuntime } from "@/modules/ai/service";

import {
  canonicalizeTrustedOrigins,
  createContext,
  parseGraphQLOrigin,
  type GraphQLContext,
} from "./context";
import {
  createGraphQLError,
  isGraphQLErrorCode,
  publicErrorMessage,
  type GraphQLErrorCode,
} from "./errors";
import { MAX_ALIASES, MAX_QUERY_TOKENS, MAX_REQUEST_BYTES } from "./limits";
import {
  getPerformanceDiagnosticCandidate,
  measureDatabaseQueries,
  type PerformanceDiagnosticSettings,
} from "./query-instrumentation";
import { schema as productionSchema } from "./schema";

export type GraphQLEnvironment = "development" | "production" | "test";

export type GraphQLLogger = SecurityEventLogger;

export type CreateGraphQLHandlerOptions = {
  auth: BetterAuthRuntime;
  clientAddressConfig: TrustedProxyConfig;
  database: Database;
  databaseQueryDiagnostics?: PerformanceDiagnosticSettings;
  environment: GraphQLEnvironment;
  logger?: GraphQLLogger;
  metrics: Task12Metrics;
  operationLimiter: OperationLimiter;
  searchIndexMaintenance: SearchIndexMaintenance;
  searchRuntime: SearchRuntime;
  schema?: GraphQLSchema;
  trustedOrigins: readonly string[];
  fileRuntime?: FileServiceRuntime;
  importRuntime?: ImportServiceRuntime;
  settingsRuntime?: WorkspaceMemberRuntime;
  aiRuntime: AiAnalysisRuntime;
};

type NextRouteContext = {
  authenticatedContext: GraphQLContext;
  params: Promise<Record<string, string>>;
  requestId: string;
};

const validRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createGraphQLRequestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  return candidate && validRequestIdPattern.test(candidate)
    ? candidate.toLowerCase()
    : crypto.randomUUID();
}

export function createGraphQLInternalErrorResponse(
  requestId: string,
): Response {
  const response = httpErrorResponse({
    code: "INTERNAL",
    requestId,
    status: 500,
  });
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-request-id", requestId);
  headers.set("access-control-expose-headers", "x-request-id");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function httpErrorResponse(input: {
  code: GraphQLErrorCode;
  message?: string;
  requestId: string;
  status: number;
}): Response {
  return Response.json(
    {
      errors: [
        {
          message: input.message ?? publicErrorMessage(input.code),
          extensions: {
            code: input.code,
            requestId: input.requestId,
          },
        },
      ],
    },
    { status: input.status },
  );
}

function withResponsePolicy(
  response: Response,
  input: {
    allowedMethods: readonly string[];
    request: Request;
    requestId: string;
    trustedOrigins: readonly string[];
  },
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-request-id", input.requestId);
  headers.set("access-control-expose-headers", "x-request-id");
  const rawOrigin = input.request.headers.get("origin");
  if (rawOrigin) {
    const origin = parseGraphQLOrigin(rawOrigin);
    if (origin && input.trustedOrigins.includes(origin)) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
      headers.set(
        "access-control-allow-headers",
        "content-type, x-api-key, x-graphql-yoga-csrf, x-request-id",
      );
      headers.set(
        "access-control-allow-methods",
        input.allowedMethods.join(", "),
      );
      headers.append("vary", "origin");
    }
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function inspectPostBody(
  request: Request,
): Promise<{ bodyText: string; tooLarge: boolean }> {
  const reader = request.clone().body?.getReader();
  if (!reader) return { bodyText: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        void reader.cancel();
        return { bodyText: "", tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bodyText: new TextDecoder().decode(body), tooLarge: false };
}

function acceptsJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const parts = value.split(";");
  if (parts[0]?.trim().toLowerCase() !== "application/json") return false;
  if (parts.length === 1) return true;
  if (parts.length !== 2) return false;
  return /^charset\s*=\s*(?:utf-8|"utf-8")$/iu.test(parts[1]?.trim() ?? "");
}

function errorCodeFor(error: GraphQLError): GraphQLErrorCode {
  const code = error.extensions.code;
  if (isGraphQLErrorCode(code)) return code;
  if (/introspection/iu.test(error.message)) return "FORBIDDEN";
  return error.path ? "INTERNAL" : "VALIDATION_FAILED";
}

function expectedGraphQLError(
  error: unknown,
): { code: GraphQLErrorCode; message: string; retryAfterMs?: number } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    extensions?: { code?: unknown; retryAfterMs?: unknown };
    message?: unknown;
    originalError?: unknown;
  };
  if (
    isGraphQLErrorCode(candidate.extensions?.code) &&
    typeof candidate.message === "string"
  ) {
    return {
      code: candidate.extensions.code,
      message: candidate.message,
      ...(candidate.extensions.retryAfterMs !== undefined
        ? { retryAfterMs: candidate.extensions.retryAfterMs as number }
        : {}),
    };
  }
  return expectedGraphQLError(candidate.originalError);
}

function normalizeExecutionResult(
  result: ExecutionResult,
  requestId: string,
  logger: GraphQLLogger,
): ExecutionResult {
  if (!result.errors?.length) return result;
  let recordedInternal = false;
  return {
    ...result,
    errors: result.errors.map((error) => {
      const code = errorCodeFor(error);
      if (code === "INTERNAL" && !recordedInternal) {
        recordedInternal = true;
        logger.log({
          event: "graphql.request.internal",
          requestId,
          severity: "error",
        });
      }
      return new GraphQLError(
        code === "INTERNAL" ? publicErrorMessage(code) : error.message,
        {
          extensions: {
            code,
            requestId,
            ...(code === "RATE_LIMITED" &&
            Number.isSafeInteger(error.extensions.retryAfterMs) &&
            Number(error.extensions.retryAfterMs) >= 1 &&
            Number(error.extensions.retryAfterMs) <= 3_600_000
              ? { retryAfterMs: Number(error.extensions.retryAfterMs) }
              : {}),
          },
          path: error.path,
        },
      );
    }),
  };
}

async function normalizeYogaResponse(
  response: Response,
  requestId: string,
  logger: GraphQLLogger,
): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    return response;
  }
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== "object") return response;
  const result = payload as {
    data?: unknown;
    errors?: Array<{
      extensions?: Record<string, unknown>;
      message?: unknown;
      path?: unknown;
    }>;
  };
  if (!Array.isArray(result.errors)) return response;
  let recordedInternal = false;
  const errors = result.errors.map((error) => {
    const rawCode = error.extensions?.code;
    const message =
      typeof error.message === "string"
        ? error.message
        : publicErrorMessage("INTERNAL");
    const code = isGraphQLErrorCode(rawCode)
      ? rawCode
      : /introspection/iu.test(message)
        ? "FORBIDDEN"
        : rawCode === "BAD_REQUEST" || error.path === undefined
          ? "VALIDATION_FAILED"
          : "INTERNAL";
    if (code === "INTERNAL" && rawCode !== "INTERNAL" && !recordedInternal) {
      recordedInternal = true;
      logger.log({
        event: "graphql.request.internal",
        requestId,
        severity: "error",
      });
    }
    return {
      message: code === "INTERNAL" ? publicErrorMessage(code) : message,
      extensions: {
        code,
        requestId,
        ...(code === "RATE_LIMITED" &&
        Number.isSafeInteger(error.extensions?.retryAfterMs) &&
        Number(error.extensions?.retryAfterMs) >= 1 &&
        Number(error.extensions?.retryAfterMs) <= 3_600_000
          ? { retryAfterMs: Number(error.extensions?.retryAfterMs) }
          : {}),
      },
      ...(Array.isArray(error.path) ? { path: error.path } : {}),
    };
  });
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ...result, errors }), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function resultPolicyPlugin(logger: GraphQLLogger): Plugin {
  return {
    onExecutionResult({ context, result, setResult }) {
      if (!result || Symbol.asyncIterator in result) return;
      const requestContext = context as { requestId?: unknown };
      const requestId =
        typeof requestContext.requestId === "string"
          ? requestContext.requestId
          : crypto.randomUUID();
      setResult(normalizeExecutionResult(result, requestId, logger));
    },
  };
}

export function createGraphQLHandler(
  options: CreateGraphQLHandlerOptions,
): (request: Request, requestId?: string) => Promise<Response> {
  const trustedOrigins = canonicalizeTrustedOrigins(options.trustedOrigins);
  const environment = options.environment;
  const logger = options.logger ?? noopSecurityEventLogger;
  const allowedMethods =
    environment === "development"
      ? (["POST", "OPTIONS", "GET"] as const)
      : (["POST", "OPTIONS"] as const);
  const yoga = createYoga<NextRouteContext, GraphQLContext>({
    batching: false,
    cors: {
      allowedHeaders: [
        "content-type",
        "x-api-key",
        "x-graphql-yoga-csrf",
        "x-request-id",
      ],
      credentials: true,
      exposedHeaders: ["x-request-id"],
      methods: [...allowedMethods],
      origin: [...trustedOrigins],
    },
    context: (initialContext) => initialContext.authenticatedContext,
    fetchAPI: { Response },
    graphiql: environment === "development",
    graphqlEndpoint: "/api/graphql",
    landingPage: false,
    logging: false,
    maskedErrors: {
      errorMessage: publicErrorMessage("INTERNAL"),
      isDev: false,
      maskError(error, message) {
        const expected = expectedGraphQLError(error);
        if (expected) {
          return createGraphQLError(expected.code, expected.message, {
            retryAfterMs: expected.retryAfterMs,
          });
        }
        const masked = maskYogaError(error, message, false);
        return masked === error
          ? masked
          : createGraphQLError("INTERNAL", message);
      },
    },
    multipart: false,
    plugins: [
      csrfPreventionPlugin(),
      maxTokensPlugin({
        errorMessage: "Operation exceeds the allowed token count.",
        exposeLimits: false,
        n: MAX_QUERY_TOKENS,
      }),
      maxAliasesPlugin({
        errorMessage: "Operation exceeds the allowed alias count.",
        exposeLimits: false,
        n: MAX_ALIASES,
      }),
      disableIntrospectionPlugin({
        isDisabled(_request, context) {
          if (environment !== "production") return false;
          const permissions = (context as Partial<NextRouteContext>)
            .authenticatedContext?.permissions;
          return !permissions?.has("graphql:introspect");
        },
      }),
      resultPolicyPlugin(logger),
    ],
    schema: options.schema ?? productionSchema,
  });

  return async function handleGraphQL(
    request: Request,
    establishedRequestId?: string,
  ): Promise<Response> {
    const requestId = establishedRequestId ?? createGraphQLRequestId(request);
    const clientAddress = classifyClientAddress(
      request,
      options.clientAddressConfig,
    );
    const method = request.method.toUpperCase();
    const finalize = (response: Response) =>
      withResponsePolicy(response, {
        allowedMethods,
        request,
        requestId,
        trustedOrigins,
      });

    try {
      if (method === "OPTIONS") {
        const rawOrigin = request.headers.get("origin");
        if (rawOrigin) {
          const origin = parseGraphQLOrigin(rawOrigin);
          if (!origin || !trustedOrigins.includes(origin)) {
            return finalize(
              httpErrorResponse({
                code: "FORBIDDEN",
                requestId,
                status: 403,
              }),
            );
          }
        }
        return finalize(new Response(null, { status: 204 }));
      }

      if (method === "GET" && environment !== "development") {
        return finalize(
          httpErrorResponse({
            code: "VALIDATION_FAILED",
            message: "GET is not available for this GraphQL endpoint.",
            requestId,
            status: 405,
          }),
        );
      }
      if (method !== "POST" && method !== "GET") {
        return finalize(
          httpErrorResponse({
            code: "VALIDATION_FAILED",
            message: "The HTTP method is not supported.",
            requestId,
            status: 405,
          }),
        );
      }

      if (method === "POST") {
        const contentEncoding = request.headers
          .get("content-encoding")
          ?.trim()
          .toLowerCase();
        if (
          (contentEncoding && contentEncoding !== "identity") ||
          !acceptsJsonContentType(request.headers.get("content-type"))
        ) {
          return finalize(
            httpErrorResponse({
              code: "VALIDATION_FAILED",
              message: "Only unencoded application/json requests are accepted.",
              requestId,
              status: 415,
            }),
          );
        }
        const declaredLength = Number(request.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_REQUEST_BYTES
        ) {
          return finalize(
            httpErrorResponse({
              code: "VALIDATION_FAILED",
              message: "The request body is too large.",
              requestId,
              status: 413,
            }),
          );
        }
        const inspected = await inspectPostBody(request);
        if (inspected.tooLarge) {
          return finalize(
            httpErrorResponse({
              code: "VALIDATION_FAILED",
              message: "The request body is too large.",
              requestId,
              status: 413,
            }),
          );
        }
        try {
          if (Array.isArray(JSON.parse(inspected.bodyText))) {
            return finalize(
              httpErrorResponse({
                code: "VALIDATION_FAILED",
                message: "GraphQL request batching is not supported.",
                requestId,
                status: 400,
              }),
            );
          }
        } catch {
          // Yoga produces the normalized parse response for malformed JSON.
        }
      }

      const diagnostics = options.databaseQueryDiagnostics;
      const diagnosticCandidate = diagnostics
        ? getPerformanceDiagnosticCandidate(request, diagnostics)
        : null;
      const executeAuthenticatedRequest = async (): Promise<{
        principalId: string | null;
        response: Response;
      }> => {
        let authenticatedContext: GraphQLContext;
        try {
          authenticatedContext = await createContext({
            auth: options.auth,
            clientAddress,
            database: options.database,
            request,
            requestId,
            metrics: options.metrics,
            operationLimiter: options.operationLimiter,
            searchIndexMaintenance: options.searchIndexMaintenance,
            searchRuntime: options.searchRuntime,
            trustedOrigins,
            fileRuntime: options.fileRuntime,
            importRuntime: options.importRuntime,
            settingsRuntime: options.settingsRuntime,
            aiRuntime: options.aiRuntime,
          });
        } catch (error) {
          if (
            error instanceof GraphQLError &&
            isGraphQLErrorCode(error.extensions.code)
          ) {
            const code = error.extensions.code;
            return {
              principalId: null,
              response: httpErrorResponse({
                code,
                message: error.message,
                requestId,
                status:
                  code === "UNAUTHENTICATED"
                    ? 401
                    : code === "PRECONDITION_FAILED"
                      ? 412
                      : 403,
              }),
            };
          }
          logger.log({
            event: "graphql.request.internal",
            requestId,
            severity: "error",
          });
          return {
            principalId: null,
            response: httpErrorResponse({
              code: "INTERNAL",
              requestId,
              status: 500,
            }),
          };
        }

        try {
          const response = await yoga.handleRequest(request, {
            authenticatedContext,
            params: Promise.resolve({}),
            requestId,
          });
          return {
            principalId: authenticatedContext.actor.principalId,
            response: await normalizeYogaResponse(response, requestId, logger),
          };
        } catch {
          logger.log({
            event: "graphql.request.internal",
            requestId,
            severity: "error",
          });
          return {
            principalId: authenticatedContext.actor.principalId,
            response: httpErrorResponse({
              code: "INTERNAL",
              requestId,
              status: 500,
            }),
          };
        }
      };

      const measured = diagnosticCandidate
        ? await measureDatabaseQueries(executeAuthenticatedRequest)
        : null;
      const outcome = measured?.value ?? (await executeAuthenticatedRequest());
      let response = outcome.response;
      if (
        measured &&
        outcome.principalId === diagnosticCandidate?.principalId
      ) {
        const headers = new Headers(response.headers);
        headers.set("x-humans-db-query-count", String(measured.queryCount));
        response = new Response(response.body, {
          headers,
          status: response.status,
          statusText: response.statusText,
        });
      }
      return finalize(response);
    } catch {
      logger.log({
        event: "graphql.request.internal",
        requestId,
        severity: "error",
      });
      return finalize(
        httpErrorResponse({
          code: "INTERNAL",
          requestId,
          status: 500,
        }),
      );
    }
  };
}
