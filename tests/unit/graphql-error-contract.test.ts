import { describe, expect, it } from "vitest";

import { GRAPHQL_ERROR_CODES, publicErrorMessage } from "@/graphql/errors";
import {
  graphQLRequestIdPattern,
  normalizePublicGraphQLError,
  normalizePublicGraphQLErrors,
} from "@/graphql/error-contract";

const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";

describe("GraphQL public error contract", () => {
  it("keeps every supported code stable and carries one correlation ID", () => {
    for (const code of GRAPHQL_ERROR_CODES) {
      const result = normalizePublicGraphQLError(
        {
          extensions: {
            code,
            requestId: "01984e93-7644-72c6-82d0-fda7f590581f",
          },
          message: publicErrorMessage(code),
        },
        requestId,
      );

      expect(result).toEqual({
        code,
        message: publicErrorMessage(code),
        requestId,
      });
      expect(graphQLRequestIdPattern.test(result.requestId!)).toBe(true);
    }
  });

  it("masks unknown codes and upstream exception text", () => {
    const upstreamSecret =
      "provider-key=sk-live-redacted prompt=private-person-record";
    expect(
      normalizePublicGraphQLError(
        {
          extensions: { code: "UPSTREAM_DATABASE_ERROR" },
          message: upstreamSecret,
        },
        requestId,
      ),
    ).toEqual({
      code: "INTERNAL",
      message: publicErrorMessage("INTERNAL"),
      requestId,
    });
  });

  it("does not trust exception text even when a code is allowlisted", () => {
    expect(
      normalizePublicGraphQLError(
        {
          extensions: { code: "PROVIDER_UNAVAILABLE" },
          message: "provider-key=sk-live-redacted upstream stack trace",
        },
        requestId,
      ),
    ).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      message: publicErrorMessage("PROVIDER_UNAVAILABLE"),
      requestId,
    });
  });

  it("uses a valid extension ID when the header is missing or malformed", () => {
    const extensionId = "01984e93-7644-72c6-82d0-fda7f590581f";
    expect(
      normalizePublicGraphQLError({
        extensions: { code: "NOT_FOUND", requestId: extensionId },
        message: publicErrorMessage("NOT_FOUND"),
      }),
    ).toMatchObject({ code: "NOT_FOUND", requestId: extensionId });

    expect(
      normalizePublicGraphQLError({
        extensions: { code: "NOT_FOUND", requestId: "not-a-request-id" },
        message: publicErrorMessage("NOT_FOUND"),
      }),
    ).toEqual({
      code: "NOT_FOUND",
      message: publicErrorMessage("NOT_FOUND"),
    });

    expect(
      normalizePublicGraphQLError(
        {
          extensions: { code: "NOT_FOUND", requestId: extensionId },
          message: publicErrorMessage("NOT_FOUND"),
        },
        "malformed-response-header",
      ),
    ).toMatchObject({ code: "NOT_FOUND", requestId: extensionId });
  });

  it("always returns a safe internal fallback for an empty error array", () => {
    expect(normalizePublicGraphQLErrors([], requestId)).toEqual([
      {
        code: "INTERNAL",
        message: publicErrorMessage("INTERNAL"),
        requestId,
      },
    ]);
  });
});
