import {
  isGraphQLErrorCode,
  publicErrorMessage,
  type GraphQLErrorCode,
} from "./errors";

/**
 * The API boundary is authoritative for correlation. A response header wins
 * over an extension value so a malformed or stale payload cannot cause the
 * client to display a different support identifier than the one operators
 * can search for.
 */
export const graphQLRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type GraphQLErrorPayload = {
  extensions?: { code?: unknown; requestId?: unknown };
  message?: unknown;
};

export type PublicGraphQLError = {
  code: GraphQLErrorCode | "INVALID_RESPONSE" | "NETWORK_ERROR";
  message: string;
  requestId?: string;
};

export function normalizeGraphQLRequestId(value: unknown): string | undefined {
  if (typeof value === "string" && graphQLRequestIdPattern.test(value.trim()))
    return value.trim().toLowerCase();
  return undefined;
}

function normalizeRequestId(
  extensionValue: unknown,
  responseRequestId: string | null | undefined,
): string | undefined {
  const header = normalizeGraphQLRequestId(responseRequestId);
  if (header) return header;
  return normalizeGraphQLRequestId(extensionValue);
}

/**
 * Convert untrusted GraphQL transport output into the bounded public error
 * contract consumed by browser and server callers. Unknown codes become
 * internal failures, while non-string messages receive safe code-specific
 * copy; upstream exception text must never become user-visible error copy.
 */
export function normalizePublicGraphQLError(
  error: unknown,
  responseRequestId?: string | null,
): PublicGraphQLError {
  const payload = asGraphQLErrorPayload(error);
  const code = isGraphQLErrorCode(payload.extensions?.code)
    ? payload.extensions.code
    : "INTERNAL";
  const message = publicErrorMessage(code);
  const requestId = normalizeRequestId(
    payload.extensions?.requestId,
    responseRequestId,
  );
  return {
    code,
    message,
    ...(requestId ? { requestId } : {}),
  };
}

export function normalizePublicGraphQLErrors(
  errors: readonly unknown[] | undefined,
  responseRequestId?: string | null,
): readonly PublicGraphQLError[] {
  const normalized = errors?.map((error) =>
    normalizePublicGraphQLError(error, responseRequestId),
  );
  return normalized?.length
    ? normalized
    : [
        normalizePublicGraphQLError(
          { message: publicErrorMessage("INTERNAL") },
          responseRequestId,
        ),
      ];
}

function asGraphQLErrorPayload(value: unknown): GraphQLErrorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as {
    extensions?: unknown;
    message?: unknown;
  };
  const extensions =
    candidate.extensions &&
    typeof candidate.extensions === "object" &&
    !Array.isArray(candidate.extensions)
      ? (candidate.extensions as GraphQLErrorPayload["extensions"])
      : undefined;
  return {
    ...(extensions ? { extensions } : {}),
    ...(typeof candidate.message === "string"
      ? { message: candidate.message }
      : {}),
  };
}
