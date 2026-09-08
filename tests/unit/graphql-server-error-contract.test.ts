import { describe, expect, it, vi } from "vitest";

import { httpErrorResponse, normalizeYogaResponse } from "@/graphql/server";

const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";

describe("GraphQL server error contract", () => {
  it("normalizes early HTTP boundary messages before Yoga can run", async () => {
    const secret =
      "provider-key=sk-live-redacted private prompt database password=secret";
    const response = httpErrorResponse({
      code: "PROVIDER_UNAVAILABLE",
      message: secret,
      requestId,
      status: 503,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      errors: [
        {
          message: "A required provider is unavailable.",
          extensions: {
            code: "PROVIDER_UNAVAILABLE",
            requestId,
          },
        },
      ],
    });
  });

  it("contains primitive and null Yoga errors as internal failures", async () => {
    const logger = { log: vi.fn() };
    const response = await normalizeYogaResponse(
      new Response(
        JSON.stringify({
          errors: [null, "provider-password=private", []],
        }),
        { headers: { "content-type": "application/json" }, status: 500 },
      ),
      requestId,
      logger,
    );

    expect(await response.json()).toEqual({
      errors: [
        {
          message: "An internal error occurred.",
          extensions: { code: "INTERNAL", requestId },
        },
        {
          message: "An internal error occurred.",
          extensions: { code: "INTERNAL", requestId },
        },
        {
          message: "An internal error occurred.",
          extensions: { code: "INTERNAL", requestId },
        },
      ],
    });
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
