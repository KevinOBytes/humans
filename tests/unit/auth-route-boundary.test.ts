// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createAuthRouteHandlers } from "@/app/api/auth/[...all]/route";

const protectedRoutes = [
  "/api/auth/organization/invite-member",
  "/api/auth/organization/cancel-invitation",
  "/api/auth/organization/update-member-role",
  "/api/auth/organization/remove-member",
  "/api/auth/api-key/create",
  "/api/auth/api-key/update",
  "/api/auth/api-key/delete",
] as const;

describe("Better Auth administration boundary", () => {
  it.each([
    ["loader", async () => Promise.reject(new Error("loader secret"))],
    [
      "delegate",
      async () => ({
        POST: async () => Promise.reject(new Error("database commit secret")),
      }),
    ],
  ])(
    "contains and correlates an unexpected %s failure",
    async (_name, loader) => {
      const logger = { log: vi.fn() };
      const handlers = createAuthRouteHandlers(loader, logger);
      const response = await handlers.POST(
        new Request("https://humans.example.test/api/auth/sign-in/email", {
          headers: {
            "x-request-id": "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1",
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-request-id")).toBe(
        "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      );
      const body = await response.text();
      expect(body).not.toContain("secret");
      expect(JSON.parse(body)).toEqual({
        code: "AUTH_SERVICE_UNAVAILABLE",
        message: "Authentication service is temporarily unavailable.",
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      });
      expect(logger.log).toHaveBeenCalledWith({
        event: "auth.infrastructure.failure",
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
        severity: "error",
      });
    },
  );

  it.each(protectedRoutes)(
    "blocks POST %s before Better Auth is initialized",
    async (path) => {
      const delegate = vi.fn();
      const loadHandlers = vi.fn(async () => ({ POST: delegate }));
      const handlers = createAuthRouteHandlers(loadHandlers);

      const response = await handlers.POST(
        new Request(`https://humans.example.test${path}`, { method: "POST" }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "AUTH_ADMINISTRATION_DISABLED",
        message: "This administration endpoint is unavailable.",
      });
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
      expect(loadHandlers).not.toHaveBeenCalled();
      expect(delegate).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/auth/organization/accept-invitation",
    "/api/auth/two-factor/disable",
  ])(
    "blocks direct Better Auth lifecycle mutation %s before initialization",
    async (path) => {
      const loadHandlers = vi.fn(async () => ({ POST: vi.fn() }));
      const handlers = createAuthRouteHandlers(loadHandlers);
      const response = await handlers.POST(
        new Request(`https://humans.example.test${path}`, {
          method: "POST",
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "AUTH_LIFECYCLE_WRAPPER_REQUIRED",
      });
      expect(loadHandlers).not.toHaveBeenCalled();
    },
  );

  it("normalizes protected path separators, encoding, and trailing slashes", async () => {
    const loadHandlers = vi.fn(async () => ({ POST: vi.fn() }));
    const handlers = createAuthRouteHandlers(loadHandlers);

    const response = await handlers.POST(
      new Request(
        "https://humans.example.test/api//auth/organization%2Finvite-member///?ignored=true",
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(403);
    expect(loadHandlers).not.toHaveBeenCalled();
  });

  it.each([
    "/api/auth/organization/set-active",
    "/api/auth/sign-in/email",
    "/api/auth/sign-in/username",
    "/api/auth/sign-out",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/two-factor/enable",
    "/api/auth/two-factor/verify-totp",
    "/api/auth/two-factor/generate-backup-codes",
    "/api/auth/two-factor/verify-backup-code",
  ])("continues delegating allowed POST %s", async (path) => {
    const delegatedResponse = new Response("delegated", { status: 202 });
    const delegate = vi.fn(async () => delegatedResponse);
    const loadHandlers = vi.fn(async () => ({ POST: delegate }));
    const handlers = createAuthRouteHandlers(loadHandlers);
    const request = new Request(`https://humans.example.test${path}`, {
      method: "POST",
    });

    await expect(handlers.POST(request)).resolves.toBe(delegatedResponse);
    expect(loadHandlers).toHaveBeenCalledOnce();
    expect(delegate).toHaveBeenCalledWith(request);
  });

  it("matches the protected boundary by exact method and pathname", async () => {
    const delegatedResponse = new Response("delegated");
    const post = vi.fn(async () => delegatedResponse);
    const get = vi.fn(async () => delegatedResponse);
    const loadHandlers = vi.fn(async () => ({ GET: get, POST: post }));
    const handlers = createAuthRouteHandlers(loadHandlers);

    await expect(
      handlers.POST(
        new Request(
          "https://humans.example.test/api/auth/organization/invite-member-preview",
          { method: "POST" },
        ),
      ),
    ).resolves.toBe(delegatedResponse);
    await expect(
      handlers.GET(
        new Request(
          "https://humans.example.test/api/auth/organization/invite-member",
        ),
      ),
    ).resolves.toBe(delegatedResponse);

    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it("correlates an unavailable method without an empty response", async () => {
    const handlers = createAuthRouteHandlers(async () => ({}));
    const response = await handlers.PATCH(
      new Request("https://humans.example.test/api/auth/session", {
        method: "PATCH",
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(response.json()).resolves.toMatchObject({
      code: "AUTH_METHOD_NOT_ALLOWED",
    });
  });

  it.each([
    "/api/auth/sign-out",
    "/api/auth/change-password",
    "/api/auth/revoke-sessions",
    "/api/auth/request-password-reset",
    "/api/auth/two-factor/enable",
    "/api/auth/two-factor/generate-backup-codes",
  ])(
    "rejects API-key-bearing interactive route %s before initialization",
    async (path) => {
      const loadHandlers = vi.fn(async () => ({ POST: vi.fn() }));
      const handlers = createAuthRouteHandlers(loadHandlers);
      const response = await handlers.POST(
        new Request(`https://humans.example.test${path}`, {
          body: "{}",
          headers: {
            authorization: "Bearer workspace-key",
            cookie: "better-auth.session_token=mixed-mode",
            "content-type": "application/json",
            "x-api-key": "workspace-key",
            "x-request-id": "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1",
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("x-request-id")).toBe(
        "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      );
      await expect(response.json()).resolves.toMatchObject({
        code: "AUTH_API_KEY_INTERACTIVE_FORBIDDEN",
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      });
      expect(loadHandlers).not.toHaveBeenCalled();
    },
  );
});
