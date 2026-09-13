// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createAuthRouteHandlers,
  createPreparedAuthHandler,
} from "@/app/api/auth/[...all]/handlers";
import {
  AUTH_REQUEST_ID_HEADER,
  decorateAuthBoundaryResponse,
  prepareAuthBoundaryRequest,
} from "@/modules/auth/request-boundary";

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

  it.each(["GET", "POST", "PATCH", "PUT", "DELETE"] as const)(
    "blocks Better Auth admin routes for %s before application authorization",
    async (method) => {
      const delegate = vi.fn();
      const loadHandlers = vi.fn(async () => ({
        [method]: delegate,
      }));
      const handlers = createAuthRouteHandlers(loadHandlers);

      const response = await handlers[method](
        new Request("https://humans.example.test/api/auth/admin/list-users", {
          method,
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "AUTH_ADMINISTRATION_DISABLED",
      });
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

    const response = await handlers.POST(request);
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(response.text()).resolves.toBe("delegated");
    expect(loadHandlers).toHaveBeenCalledOnce();
    expect(delegate).toHaveBeenCalledWith(request);
  });

  it("redacts and correlates a delegated authentication failure", async () => {
    const handlers = createAuthRouteHandlers(async () => ({
      POST: async () =>
        new Response(
          JSON.stringify({
            code: "untrusted-code",
            diagnostic: "private database secret",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 503,
          },
        ),
    }));

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
    await expect(response.json()).resolves.toEqual({
      code: "AUTH_REQUEST_FAILED",
      message: "Authentication request failed.",
      requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
    });
  });

  it("preserves the prepared production request ID through delegated failures", async () => {
    let preparedRequestId: string | undefined;
    const handlers = createAuthRouteHandlers(async () => ({
      POST: async (request) => {
        const prepared = await prepareAuthBoundaryRequest(request, {
          authSecret: "test-auth-secret",
          clientAddressConfig: { deploymentMode: "docker", mode: "none" },
        });
        preparedRequestId =
          prepared.headers.get(AUTH_REQUEST_ID_HEADER) ?? undefined;
        return decorateAuthBoundaryResponse(
          new Response("private provider failure", { status: 503 }),
          preparedRequestId!,
        );
      },
    }));

    const response = await handlers.POST(
      new Request("https://humans.example.test/api/auth/sign-in/email", {
        method: "POST",
      }),
    );
    const body = await response.json();

    expect(preparedRequestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers.get("x-request-id")).toBe(preparedRequestId);
    expect(body).toMatchObject({ requestId: preparedRequestId });
  });

  it.each([undefined, "not-a-request-id"])(
    "preserves the prepared ID when a delegated handler throws with inbound ID %s",
    async (inboundRequestId) => {
      const logger = { log: vi.fn() };
      let preparedRequestId: string | undefined;
      const handler = createPreparedAuthHandler({
        handler: async () => Promise.reject(new Error("private failure")),
        logger,
        prepare: async (request) => {
          const prepared = await prepareAuthBoundaryRequest(request, {
            authSecret: "test-auth-secret",
            clientAddressConfig: { deploymentMode: "docker", mode: "none" },
          });
          preparedRequestId =
            prepared.headers.get(AUTH_REQUEST_ID_HEADER) ?? undefined;
          return prepared;
        },
      });

      const response = await handler(
        new Request("https://humans.example.test/api/auth/sign-in/email", {
          headers: inboundRequestId
            ? { "x-request-id": inboundRequestId }
            : undefined,
          method: "POST",
        }),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-request-id")).toBe(preparedRequestId);
      await expect(response.json()).resolves.toEqual({
        code: "AUTH_SERVICE_UNAVAILABLE",
        message: "Authentication service is temporarily unavailable.",
        requestId: preparedRequestId,
      });
      expect(logger.log).toHaveBeenCalledWith({
        event: "auth.infrastructure.failure",
        requestId: preparedRequestId,
        severity: "error",
      });
    },
  );

  it.each(["/api/auth/sign-in/email", "/api/auth/sign-in/username"])(
    "bootstraps the configured administrator before %s",
    async (path) => {
      const events: string[] = [];
      const bootstrap = vi.fn(async () => {
        events.push("bootstrap");
      });
      const delegate = vi.fn(async () => {
        events.push("delegate");
        return new Response("delegated", { status: 202 });
      });
      const handlers = createAuthRouteHandlers(async () => ({
        POST: delegate,
        bootstrap,
      }));
      const request = new Request(`https://humans.example.test${path}`, {
        method: "POST",
      });

      await expect(handlers.POST(request)).resolves.toHaveProperty(
        "status",
        202,
      );
      expect(bootstrap).toHaveBeenCalledOnce();
      expect(delegate).toHaveBeenCalledWith(request);
      expect(events).toEqual(["bootstrap", "delegate"]);
    },
  );

  it("matches the protected boundary by exact method and pathname", async () => {
    const delegatedResponse = new Response("delegated");
    const post = vi.fn(async () => delegatedResponse);
    const get = vi.fn(async () => delegatedResponse);
    const loadHandlers = vi.fn(async () => ({ GET: get, POST: post }));
    const handlers = createAuthRouteHandlers(loadHandlers);

    const postResponse = await handlers.POST(
      new Request(
        "https://humans.example.test/api/auth/organization/invite-member-preview",
        { method: "POST" },
      ),
    );
    const getResponse = await handlers.GET(
      new Request(
        "https://humans.example.test/api/auth/organization/invite-member",
      ),
    );

    expect(postResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    expect(postResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(getResponse.headers.get("cache-control")).toBe("private, no-store");

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
