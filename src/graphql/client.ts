"use client";

import type { TypedDocumentString } from "@/graphql/generated/graphql";
import {
  normalizeGraphQLRequestId,
  normalizePublicGraphQLErrors,
  type PublicGraphQLError,
} from "@/graphql/error-contract";

export type { PublicGraphQLError } from "@/graphql/error-contract";

export type GraphQLResult<TData> =
  | { ok: true; data: TData; requestId?: string }
  | { ok: false; errors: readonly PublicGraphQLError[] };

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: readonly unknown[];
};

export async function executeBrowserGraphQL<
  TResult,
  TVariables extends Record<string, unknown>,
>(
  document: TypedDocumentString<TResult, TVariables>,
  variables: TVariables,
  options?: { signal?: AbortSignal },
): Promise<GraphQLResult<TResult>> {
  try {
    const response = await fetch("/api/graphql", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: options?.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document.toString(), variables }),
    });
    const requestId = response.headers.get("x-request-id");
    const safeRequestId = normalizeGraphQLRequestId(requestId);
    let body: GraphQLResponse<TResult>;
    try {
      const parsed = (await response.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid GraphQL response shape");
      }
      body = parsed as GraphQLResponse<TResult>;
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: "INVALID_RESPONSE",
            message: "The server returned an unreadable response.",
            ...(safeRequestId ? { requestId: safeRequestId } : {}),
          },
        ],
      };
    }
    const hasErrors =
      Object.prototype.hasOwnProperty.call(body, "errors") &&
      (!Array.isArray(body.errors) || body.errors.length > 0);
    if (!response.ok || hasErrors || body.data === undefined) {
      return {
        ok: false,
        errors: normalizePublicGraphQLErrors(
          Array.isArray(body.errors) ? body.errors : undefined,
          safeRequestId,
        ),
      };
    }
    return {
      ok: true,
      data: body.data,
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
    };
  } catch {
    return {
      ok: false,
      errors: [
        { code: "NETWORK_ERROR", message: "The server could not be reached." },
      ],
    };
  }
}
