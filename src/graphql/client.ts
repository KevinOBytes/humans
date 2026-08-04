"use client";

import type { TypedDocumentString } from "@/graphql/generated/graphql";

export type PublicGraphQLError = {
  code: string;
  message: string;
  requestId?: string;
};

export type GraphQLResult<TData> =
  | { ok: true; data: TData; requestId?: string }
  | { ok: false; errors: readonly PublicGraphQLError[] };

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: readonly {
    message?: unknown;
    extensions?: { code?: unknown; requestId?: unknown };
  }[];
};

function publicErrors(
  body: GraphQLResponse<unknown>,
  requestId?: string | null,
) {
  const errors = body.errors?.map((error) => ({
    code:
      typeof error.extensions?.code === "string"
        ? error.extensions.code
        : "INTERNAL",
    message:
      typeof error.message === "string"
        ? error.message
        : "The request could not be completed.",
    ...(typeof error.extensions?.requestId === "string"
      ? { requestId: error.extensions.requestId }
      : requestId
        ? { requestId }
        : {}),
  }));
  return errors?.length
    ? errors
    : [
        {
          code: "INTERNAL",
          message: "The request could not be completed.",
          ...(requestId ? { requestId } : {}),
        },
      ];
}

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
    let body: GraphQLResponse<TResult>;
    try {
      body = (await response.json()) as GraphQLResponse<TResult>;
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: "INVALID_RESPONSE",
            message: "The server returned an unreadable response.",
            ...(requestId ? { requestId } : {}),
          },
        ],
      };
    }
    if (!response.ok || body.errors?.length || body.data === undefined) {
      return { ok: false, errors: publicErrors(body, requestId) };
    }
    return {
      ok: true,
      data: body.data,
      ...(requestId ? { requestId } : {}),
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
