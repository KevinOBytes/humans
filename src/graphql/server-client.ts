import "server-only";

import { headers } from "next/headers";

import type { TypedDocumentString } from "@/graphql/generated/graphql";
import { getServerEnv } from "@/lib/env/server";

type PublicGraphQLError = {
  code: string;
  message: string;
  requestId?: string;
};

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: readonly {
    message?: unknown;
    extensions?: { code?: unknown; requestId?: unknown };
  }[];
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
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let body: GraphQLResponse<TResult>;
  try {
    body = (await response.json()) as GraphQLResponse<TResult>;
  } catch {
    throw new ServerGraphQLError([
      {
        code: "INTERNAL",
        message: "The request could not be completed.",
        ...(requestId ? { requestId } : {}),
      },
    ]);
  }
  if (!response.ok || body.errors?.length || body.data === undefined) {
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
    })) ?? [
      {
        code: "INTERNAL",
        message: "The request could not be completed.",
        ...(requestId ? { requestId } : {}),
      },
    ];
    throw new ServerGraphQLError(errors);
  }
  return body.data;
}
