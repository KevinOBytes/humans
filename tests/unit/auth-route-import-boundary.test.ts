// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

describe("Better Auth module-load boundary", () => {
  afterEach(() => {
    vi.doUnmock("better-auth/next-js");
    vi.doUnmock("@/lib/env/server");
    vi.doUnmock("@/modules/auth/auth");
    vi.doUnmock("@/modules/auth/request-boundary");
    vi.doUnmock("@/db/client");
    vi.doUnmock("@/lib/email/resend");
    vi.doUnmock("@/lib/observability/security-events");
    vi.doUnmock("@/modules/auth/invite-signup");
    vi.doUnmock("@/modules/auth/email-outbox");
    vi.resetModules();
  });

  it("denies a protected route without importing the adapter or application auth", async () => {
    vi.resetModules();
    vi.doMock("better-auth/next-js", () => {
      throw new Error("adapter must not load for a denied request");
    });
    vi.doMock("@/modules/auth/auth", () => {
      throw new Error("application auth must not load for a denied request");
    });

    const route = await import("@/app/api/auth/[...all]/route");
    const response = await route.POST(
      new Request(
        "https://humans.example.test/api/auth/organization/invite-member",
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(403);
  });

  it("loads and delegates through both auth modules after an allowed request", async () => {
    const delegatedResponse = new Response("delegated", { status: 202 });
    const delegatedPost = vi.fn(async () => delegatedResponse);
    const toNextJsHandler = vi.fn(() => ({ POST: delegatedPost }));
    const auth = { marker: "application-auth" };
    const createHumansAuth = vi.fn(() => ({ marker: "transactional-auth" }));
    const prepareAuthBoundaryRequest = vi.fn(
      async (request: Request) => request,
    );
    vi.resetModules();
    vi.doMock("better-auth/next-js", () => ({ toNextJsHandler }));
    vi.doMock("@/lib/env/server", () => ({
      getServerEnv: () => ({
        AUTH_SECRET: "test-auth-secret",
        AUTH_REGISTRATION_MODE: "public",
        DEPLOYMENT_MODE: "docker",
        TRUSTED_PROXY_MODE: "none",
      }),
    }));
    vi.doMock("@/modules/auth/auth", () => ({ auth, createHumansAuth }));
    vi.doMock("@/modules/auth/request-boundary", () => ({
      AUTH_REQUEST_ID_HEADER: "x-humans-auth-request-id",
      decorateAuthBoundaryResponse: async (response: Response) => response,
      prepareAuthBoundaryRequest,
    }));
    vi.doMock("@/db/client", () => ({ db: {} }));
    vi.doMock("@/lib/email/resend", () => ({
      createEmailSender: () => ({ send: vi.fn() }),
    }));
    vi.doMock("@/lib/observability/security-events", () => ({
      productionSecurityEventLogger: { log: vi.fn() },
    }));
    vi.doMock("@/modules/auth/invite-signup", () => ({
      createTransactionalInviteSignUpHandler: () => vi.fn(),
    }));
    vi.doMock("@/modules/auth/email-outbox", () => ({
      createAuthEmailOutboxSender: () => ({ sender: {}, queuedIds: [] }),
      runAuthEmailOutboxOnce: vi.fn(),
    }));

    const route = await import("@/app/api/auth/[...all]/route");
    const request = new Request(
      "https://humans.example.test/api/auth/sign-in/email",
      { method: "POST" },
    );

    await expect(route.POST(request)).resolves.toBe(delegatedResponse);
    expect(toNextJsHandler).toHaveBeenCalledWith(auth);
    expect(prepareAuthBoundaryRequest).toHaveBeenCalledOnce();
    expect(delegatedPost).toHaveBeenCalledWith(request);
  });

  it("contains a request-preparation failure at the outer route boundary", async () => {
    const log = vi.fn();
    vi.resetModules();
    vi.doMock("better-auth/next-js", () => ({
      toNextJsHandler: () => ({ POST: vi.fn() }),
    }));
    vi.doMock("@/lib/env/server", () => ({
      getServerEnv: () => ({
        AUTH_SECRET: "test-auth-secret",
        AUTH_REGISTRATION_MODE: "public",
        DEPLOYMENT_MODE: "docker",
        TRUSTED_PROXY_MODE: "none",
      }),
    }));
    vi.doMock("@/modules/auth/auth", () => ({
      auth: {},
      createHumansAuth: vi.fn(),
    }));
    vi.doMock("@/modules/auth/request-boundary", () => ({
      AUTH_REQUEST_ID_HEADER: "x-humans-auth-request-id",
      decorateAuthBoundaryResponse: vi.fn(),
      prepareAuthBoundaryRequest: () =>
        Promise.reject(new Error("preparation secret")),
    }));
    vi.doMock("@/db/client", () => ({ db: {} }));
    vi.doMock("@/lib/email/resend", () => ({
      createEmailSender: () => ({ send: vi.fn() }),
    }));
    vi.doMock("@/lib/observability/security-events", () => ({
      productionSecurityEventLogger: { log },
    }));
    vi.doMock("@/modules/auth/invite-signup", () => ({
      createTransactionalInviteSignUpHandler: () => vi.fn(),
    }));
    vi.doMock("@/modules/auth/email-outbox", () => ({
      createAuthEmailOutboxSender: () => ({ sender: {}, queuedIds: [] }),
      runAuthEmailOutboxOnce: vi.fn(),
    }));

    const route = await import("@/app/api/auth/[...all]/route");
    const response = await route.POST(
      new Request("https://humans.example.test/api/auth/sign-in/email", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
