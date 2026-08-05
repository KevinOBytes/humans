import { GraphQLError } from "graphql";

export const GRAPHQL_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "RATE_LIMITED",
  "UPLOAD_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "INTERNAL",
] as const;

export type GraphQLErrorCode = (typeof GRAPHQL_ERROR_CODES)[number];

const errorCodeSet: ReadonlySet<string> = new Set(GRAPHQL_ERROR_CODES);

export function isGraphQLErrorCode(value: unknown): value is GraphQLErrorCode {
  return typeof value === "string" && errorCodeSet.has(value);
}

export function createGraphQLError(
  code: GraphQLErrorCode,
  message: string,
  options: { requestId?: string; retryAfterMs?: number; status?: number } = {},
): GraphQLError {
  const retryAfterMs =
    code === "RATE_LIMITED" &&
    Number.isSafeInteger(options.retryAfterMs) &&
    options.retryAfterMs! >= 1 &&
    options.retryAfterMs! <= 3_600_000
      ? options.retryAfterMs
      : undefined;
  return new GraphQLError(message, {
    extensions: {
      code,
      ...(retryAfterMs ? { retryAfterMs } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.status
        ? { http: { status: options.status }, status: options.status }
        : {}),
    },
  });
}

export function publicErrorMessage(code: GraphQLErrorCode): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Authentication is required.";
    case "FORBIDDEN":
      return "This operation is not permitted.";
    case "NOT_FOUND":
      return "The requested resource was not found.";
    case "VALIDATION_FAILED":
      return "The request is invalid.";
    case "CONFLICT":
      return "The request conflicts with current state.";
    case "PRECONDITION_FAILED":
      return "An active workspace is required.";
    case "RATE_LIMITED":
      return "Too many requests.";
    case "UPLOAD_REJECTED":
      return "The upload was rejected.";
    case "PROVIDER_UNAVAILABLE":
      return "A required provider is unavailable.";
    case "INTERNAL":
      return "An internal error occurred.";
  }
}

/**
 * Preserve useful validation copy while preventing secrets, credentials, and
 * infrastructure details from crossing the GraphQL response boundary.
 */
export function normalizeGraphQLErrorMessage(
  code: GraphQLErrorCode,
  message: unknown,
): string {
  const fallback = publicErrorMessage(code);
  if (code === "INTERNAL" || typeof message !== "string") return fallback;
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  if (
    /(?:api[ _-]?key|authorization|bearer|credential|database|password|private|prompt|secret|stack(?:trace)?|token|sk-[a-z0-9]|sql)/iu.test(
      trimmed,
    )
  ) {
    return fallback;
  }
  return trimmed;
}
