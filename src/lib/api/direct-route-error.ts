import { correlationHeaders } from "./request-id";

/**
 * The direct HTTP routes intentionally keep their public error vocabulary
 * separate from GraphQL.  Their messages are static so neither a provider
 * error nor an arbitrary caught exception can reach a browser response.
 */
export const directRouteErrorCodes = [
  "AUTH_ADMINISTRATION_DISABLED",
  "AUTH_API_KEY_INTERACTIVE_FORBIDDEN",
  "AUTH_LIFECYCLE_WRAPPER_REQUIRED",
  "AUTH_METHOD_NOT_ALLOWED",
  "AUTH_REQUEST_FAILED",
  "AUTH_SERVICE_UNAVAILABLE",
  "FORBIDDEN",
  "INTERNAL",
  "INVALID_INPUT",
  "INVITATION_UNAVAILABLE",
  "METHOD_NOT_ALLOWED",
  "NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "SECURITY_CHANGE_REJECTED",
  "SECURITY_CHANGE_UNAVAILABLE",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
] as const;

export type DirectRouteErrorCode = (typeof directRouteErrorCodes)[number];

export function directRouteErrorMessage(code: DirectRouteErrorCode): string {
  switch (code) {
    case "AUTH_ADMINISTRATION_DISABLED":
      return "This administration endpoint is unavailable.";
    case "AUTH_API_KEY_INTERACTIVE_FORBIDDEN":
      return "API credentials cannot authorize account operations.";
    case "AUTH_LIFECYCLE_WRAPPER_REQUIRED":
      return "Use the protected account security endpoint.";
    case "AUTH_METHOD_NOT_ALLOWED":
    case "METHOD_NOT_ALLOWED":
      return "The HTTP method is not supported.";
    case "AUTH_SERVICE_UNAVAILABLE":
      return "Authentication service is temporarily unavailable.";
    case "FORBIDDEN":
      return "This request is not permitted.";
    case "INVALID_INPUT":
      return "The request is invalid.";
    case "INVITATION_UNAVAILABLE":
      return "The invitation is unavailable.";
    case "NOT_FOUND":
      return "The requested resource was not found.";
    case "PROVIDER_UNAVAILABLE":
      return "A required provider is unavailable.";
    case "RATE_LIMITED":
      return "Too many requests.";
    case "SECURITY_CHANGE_REJECTED":
      return "The security change was rejected.";
    case "SECURITY_CHANGE_UNAVAILABLE":
      return "The security change is temporarily unavailable.";
    case "UNAUTHENTICATED":
    case "UNAUTHORIZED":
      return "Authentication is required.";
    case "AUTH_REQUEST_FAILED":
    case "INTERNAL":
      return "An internal error occurred.";
  }
}

export function directRouteErrorPayload(
  code: DirectRouteErrorCode,
  requestId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    code,
    message: directRouteErrorMessage(code),
    requestId,
  };
}

export function directRouteErrorResponse(input: {
  code: DirectRouteErrorCode;
  extra?: Record<string, unknown>;
  headers?: HeadersInit;
  requestId: string;
  status: number;
}): Response {
  const headers = new Headers(input.headers);
  for (const [name, value] of correlationHeaders(input.requestId)) {
    headers.set(name, value);
  }
  return Response.json(
    directRouteErrorPayload(input.code, input.requestId, input.extra),
    { headers, status: input.status },
  );
}
