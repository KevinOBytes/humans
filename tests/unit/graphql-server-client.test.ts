// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

describe("server GraphQL transport", () => {
  afterEach(() => {
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/env/server");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the internal Docker target while preserving the public origin", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () =>
        new Headers({
          cookie: "better-auth.session_token=session-token",
        }),
    }));
    vi.doMock("@/lib/env/server", () => ({
      getServerEnv: () => ({
        NEXT_PUBLIC_APP_URL: "https://humans.example.com",
        INTERNAL_APP_URL: "http://app:3000",
      }),
    }));
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(
        JSON.stringify({ data: { viewer: { id: "viewer" } } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { executeServerGraphQL } = await import("@/graphql/server-client");
    const document = { toString: () => "query Viewer { viewer { id } }" };
    await executeServerGraphQL(document as never, {});

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://app:3000/api/graphql",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        origin: "https://humans.example.com",
        cookie: "better-auth.session_token=session-token",
      },
    });
  });
});
