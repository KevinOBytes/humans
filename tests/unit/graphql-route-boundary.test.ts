// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createGraphQLRouteHandler } from "@/app/api/graphql/handlers";
import { createGraphQLHandler } from "@/graphql/server";

const origin = "https://humans.example";
const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";

function pureGraphQLHandler(getSession: () => Promise<unknown>) {
  return createGraphQLHandler({
    auth: { api: { getSession } },
    clientAddressConfig: { deploymentMode: "docker", mode: "none" },
    database: {},
    environment: "test",
    metrics: {},
    operationLimiter: {},
    searchIndexMaintenance: {},
    searchRuntime: {
      cursorHmacKey: "61".repeat(32),
      protectedLookupHmacKey: "62".repeat(32),
    },
    aiRuntime: {
      encryptionKey: "63".repeat(32),
      hmacKey: "64".repeat(32),
    },
    trustedOrigins: [origin],
  } as unknown as Parameters<typeof createGraphQLHandler>[0]);
}

function request(body: string, init: RequestInit = {}) {
  return new Request(`${origin}/api/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "x-request-id": requestId,
      ...init.headers,
    },
    body,
    ...init,
  });
}

describe("credential-free GraphQL route boundary", () => {
  it("returns correlated private unauthenticated and malformed envelopes without database access", async () => {
    const getSession = vi.fn(async () => null);
    const handler = createGraphQLRouteHandler(
      async () => pureGraphQLHandler(getSession),
      { log: vi.fn() },
    );

    const unauthenticated = await handler(
      request(JSON.stringify({ query: "query { viewer { id } }" })),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(unauthenticated.headers.get("x-request-id")).toBe(requestId);
    expect(await unauthenticated.json()).toEqual({
      errors: [
        {
          message: "Exactly one authentication mode is required.",
          extensions: { code: "UNAUTHENTICATED", requestId },
        },
      ],
    });

    getSession.mockClear();
    const malformed = await handler(
      request(JSON.stringify([{ query: "query { viewer { id } }" }])),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("private, no-store");
    expect(malformed.headers.get("x-request-id")).toBe(requestId);
    expect(await malformed.json()).toEqual({
      errors: [
        {
          message: "GraphQL request batching is not supported.",
          extensions: { code: "VALIDATION_FAILED", requestId },
        },
      ],
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("handles trusted and untrusted preflight without authentication or providers", async () => {
    const getSession = vi.fn(async () => null);
    const handler = createGraphQLRouteHandler(
      async () => pureGraphQLHandler(getSession),
      { log: vi.fn() },
    );

    const trusted = await handler(
      new Request(`${origin}/api/graphql`, {
        method: "OPTIONS",
        headers: { origin, "x-request-id": requestId },
      }),
    );
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(trusted.headers.get("cache-control")).toBe("private, no-store");
    expect(trusted.headers.get("x-request-id")).toBe(requestId);
    expect(await trusted.text()).toBe("");

    const untrusted = await handler(
      new Request(`${origin}/api/graphql`, {
        method: "OPTIONS",
        headers: {
          origin: "https://untrusted.example",
          "x-request-id": requestId,
        },
      }),
    );
    expect(untrusted.status).toBe(403);
    expect(untrusted.headers.get("cache-control")).toBe("private, no-store");
    expect(untrusted.headers.get("x-request-id")).toBe(requestId);
    expect(await untrusted.json()).toEqual({
      errors: [
        {
          message: "This operation is not permitted.",
          extensions: { code: "FORBIDDEN", requestId },
        },
      ],
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("redacts and correlates initialization failures", async () => {
    const logger = { log: vi.fn() };
    const handler = createGraphQLRouteHandler(async () => {
      throw new Error(
        "provider response endpoint=https://private.example token=secret",
      );
    }, logger);

    const response = await handler(
      request(JSON.stringify({ query: "query { viewer { id } }" })),
    );
    const serialized = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(JSON.parse(serialized)).toEqual({
      errors: [
        {
          message: "An internal error occurred.",
          extensions: { code: "INTERNAL", requestId },
        },
      ],
    });
    expect(serialized).not.toMatch(/private\.example|token=secret/u);
    expect(logger.log).toHaveBeenCalledWith({
      event: "graphql.initialization.internal",
      requestId,
      severity: "error",
    });
  });
});
