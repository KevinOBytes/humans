// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createTwoFactorDisableHandler,
  createTwoFactorDisableRoute,
} from "@/app/api/account/two-factor/disable/route";
import type { Database } from "@/modules/auth/bootstrap-admin";

const database = {} as Database;
const origin = "https://humans.example.test";

function request(body: object, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/account/two-factor/disable`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("atomic two-factor disable route", () => {
  it("contains shared initialization failure and safely retries once on the next request", async () => {
    const delegated = vi.fn(async () => new Response(null, { status: 204 }));
    const loader = vi
      .fn<() => Promise<(request: Request) => Promise<Response>>>()
      .mockRejectedValueOnce(new Error("loader credential detail"))
      .mockResolvedValueOnce(delegated);
    const log = vi.fn();
    const route = createTwoFactorDisableRoute(loader, { log });
    const headers = {
      "x-request-id": "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1",
    };

    const failures = await Promise.all([
      route(request({ action: "disable", password: "secret" }, headers)),
      route(request({ action: "disable", password: "secret" }, headers)),
    ]);
    expect(loader).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith({
      event: "auth.infrastructure.failure",
      requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      severity: "error",
    });
    for (const result of failures) {
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("x-request-id")).toBe(
        "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      );
      const body = await result.text();
      expect(body).not.toContain("credential detail");
      expect(JSON.parse(body)).toEqual({
        code: "SECURITY_CHANGE_UNAVAILABLE",
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      });
    }

    expect(
      (await route(request({ action: "disable", password: "secret" }))).status,
    ).toBe(204);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(delegated).toHaveBeenCalledOnce();
  });

  it("contains delegated rejection without rebuilding an initialized handler", async () => {
    const delegated = vi.fn(async () => {
      throw new Error("handler token detail");
    });
    const loader = vi.fn(async () => delegated);
    const log = vi.fn();
    const route = createTwoFactorDisableRoute(loader, { log });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await route(
        request(
          { action: "disable", password: "secret" },
          { "x-request-id": "malformed" },
        ),
      );
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
      const body = await result.text();
      expect(body).not.toContain("token detail");
      expect(JSON.parse(body)).toMatchObject({
        code: "SECURITY_CHANGE_UNAVAILABLE",
        requestId: result.headers.get("x-request-id"),
      });
    }
    expect(loader).toHaveBeenCalledOnce();
    expect(delegated).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("token detail");
  });

  it("requires trusted origin and a browser session and rejects API keys", async () => {
    const change = vi.fn();
    const getSession = vi.fn<
      (headers: Headers) => Promise<{ user: { id: string } } | null>
    >(async () => ({ user: { id: "user-1" } }));
    const handler = createTwoFactorDisableHandler({
      change,
      consumeAttempt: async () => true,
      database,
      getSession,
      trustedOrigins: [origin],
    });

    expect(
      (
        await handler(
          request(
            { action: "disable", password: "secret" },
            {
              origin: "https://attacker.example",
              "sec-fetch-site": "cross-site",
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request(
            { action: "disable", password: "secret" },
            { authorization: "Bearer workspace-api-key" },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request(
            { action: "disable", password: "secret" },
            { "x-api-key": "workspace-api-key" },
          ),
        )
      ).status,
    ).toBe(403);

    getSession.mockResolvedValueOnce(null);
    expect(
      (await handler(request({ action: "disable", password: "secret" })))
        .status,
    ).toBe(401);
    expect(change).not.toHaveBeenCalled();
  });

  it("passes only the authenticated user and validated action to the transaction", async () => {
    const change = vi.fn(async () => "disabled" as const);
    const handler = createTwoFactorDisableHandler({
      change,
      consumeAttempt: async () => true,
      database,
      getSession: async () => ({ user: { id: "user-1" } }),
      trustedOrigins: [origin],
    });

    const result = await handler(
      request({ action: "disable", password: "current-password" }),
    );
    expect(result.status).toBe(200);
    expect(change).toHaveBeenCalledWith({
      action: "disable",
      database,
      password: "current-password",
      userId: "user-1",
    });
  });

  it("rejects a throttled password attempt with the ordinary generic response", async () => {
    const change = vi.fn();
    const handler = createTwoFactorDisableHandler({
      change,
      consumeAttempt: async () => false,
      database,
      getSession: async () => ({ user: { id: "user-1" } }),
      trustedOrigins: [origin],
    });

    const result = await handler(
      request({ action: "disable", password: "guessed-password" }),
    );
    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toMatchObject({
      code: "SECURITY_CHANGE_REJECTED",
    });
    expect(change).not.toHaveBeenCalled();
  });

  it("fails limiter infrastructure closed with a correlated generic response", async () => {
    const change = vi.fn();
    const handler = createTwoFactorDisableHandler({
      change,
      consumeAttempt: async () => {
        throw new Error("database unavailable");
      },
      database,
      getSession: async () => ({ user: { id: "user-1" } }),
      trustedOrigins: [origin],
    });

    const result = await handler(
      request(
        { action: "disable", password: "guessed-password" },
        { "x-request-id": "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1" },
      ),
    );
    expect(result.status).toBe(503);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    await expect(result.json()).resolves.toEqual({
      code: "SECURITY_CHANGE_UNAVAILABLE",
      requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
    });
    expect(change).not.toHaveBeenCalled();
  });
});
