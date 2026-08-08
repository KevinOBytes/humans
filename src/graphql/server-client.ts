import "server-only";

import { headers } from "next/headers";

import type { TypedDocumentString } from "@/graphql/generated/graphql";
import {
  normalizeGraphQLRequestId,
  normalizePublicGraphQLErrors,
  type PublicGraphQLError,
} from "@/graphql/error-contract";
import { getServerEnv } from "@/lib/env/server";

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: readonly unknown[];
};

export class ServerGraphQLError extends Error {
  readonly errors: readonly PublicGraphQLError[];

  constructor(errors: readonly PublicGraphQLError[]) {
    super(errors[0]?.message ?? "The request could not be completed.");
    this.name = "ServerGraphQLError";
    this.errors = errors;
  }

  hasCode(code: string) {
    return this.errors.some((error) => error.code === code);
  }
}

function sessionCookie(cookieHeader: string | null): string | undefined {
  return cookieHeader
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => /^(?:__Secure-)?better-auth\.session_token=/u.test(value));
}

export async function executeServerGraphQL<
  TResult,
  TVariables extends Record<string, unknown>,
>(
  document: TypedDocumentString<TResult, TVariables>,
  variables: TVariables,
): Promise<TResult> {
  const requestHeaders = await headers();
  const cookie = sessionCookie(requestHeaders.get("cookie"));
  const env = getServerEnv();
  const origin = new URL(env.NEXT_PUBLIC_APP_URL).origin;
  const response = await fetch(new URL("/api/graphql", origin), {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ query: document.toString(), variables }),
  });
  const requestId = normalizeGraphQLRequestId(
    response.headers.get("x-request-id"),
  );
  let body: GraphQLResponse<TResult>;
  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid GraphQL response shape");
    }
    body = parsed as GraphQLResponse<TResult>;
  } catch {
    throw new ServerGraphQLError(
      normalizePublicGraphQLErrors(undefined, requestId),
    );
  }
  const hasErrors =
    Object.prototype.hasOwnProperty.call(body, "errors") &&
    (!Array.isArray(body.errors) || body.errors.length > 0);
  if (!response.ok || hasErrors || body.data === undefined) {
    const errors = normalizePublicGraphQLErrors(
      Array.isArray(body.errors) ? body.errors : undefined,
      requestId,
    );
    throw new ServerGraphQLError(errors);
  }
  return body.data;
}
