import { describe, expect, it } from "vitest";

import { requestDirectRoute } from "@/lib/api/direct-route-client";

const requestId = "018f0000-0000-7000-8000-000000000001";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "x-request-id": requestId },
    status,
  });
}

describe("direct route client", () => {
  it("returns typed JSON success and sends same-origin credentials", async () => {
    let init: RequestInit | undefined;
    const result = await requestDirectRoute<{ status: boolean }>({
      body: { action: "cancel" },
      fetcher: async (_url, requestInit) => {
        init = requestInit;
        return response({ status: true });
      },
      method: "POST",
      url: "/api/account/two-factor/disable",
    });

    expect(result).toEqual({ ok: true, data: { status: true }, requestId });
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe('{"action":"cancel"}');
  });

  it("normalizes allowlisted errors and fails closed for malformed responses", async () => {
    const rejected = await requestDirectRoute({
      fetcher: async () => response({ code: "INVALID_INPUT" }, 400),
      url: "/api/account/invitations/handoff",
    });
    const malformed = await requestDirectRoute({
      fetcher: async () =>
        new Response("not json", {
          headers: { "x-request-id": requestId },
          status: 503,
        }),
      url: "/api/account/invitations/handoff",
    });

    expect(rejected).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      requestId,
    });
    expect(malformed).toEqual({
      ok: false,
      code: "AUTH_REQUEST_FAILED",
      requestId,
    });
  });
});
