import { describe, expect, it } from "vitest";

describe("production readiness smoke contract", () => {
  it("rejects missing, credential-bearing, and non-http URLs", async () => {
    const { parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(() => parseBaseUrl("")).toThrow(/base-url/);
    expect(() => parseBaseUrl("ftp://example.invalid")).toThrow(/HTTP/);
    expect(() => parseBaseUrl("https://user:pass@example.invalid")).toThrow(
      /credential-free/,
    );
  });

  it("parses only the explicit smoke switches", async () => {
    const { parseArgs } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(
      parseArgs([
        "--base-url",
        "https://example.invalid",
        "--two-factor",
        "--provider-contracts",
      ]),
    ).toEqual({
      baseUrl: "https://example.invalid",
      providerContracts: true,
      twoFactor: true,
    });
    expect(() => parseArgs(["--secret", "value"])).toThrow(/Unknown/);
  });

  it("never includes response bodies or credentials in its observable error shape", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const logs: string[] = [];
    await expect(
      runProductionSmoke({
        base: parseBaseUrl("https://example.invalid"),
        log: (line: string) => {
          logs.push(line);
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ secret: "do-not-print" }), {
            status: 500,
          }),
      }),
    ).rejects.toThrow(/homepage returned 500/);
    expect(logs.join("\n")).not.toContain("do-not-print");
  });

  it("requires and verifies both configured administrator sign-in identifiers", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const requests: Array<{ path: string; body?: string }> = [];
    const logs: string[] = [];
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const personId = "00000000-0000-4000-8000-000000000002";
    let syntheticDisplayName = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ path: url.pathname, body });

      if (url.pathname === "/") return new Response("Humans", { status: 200 });
      if (url.pathname === "/api/health/live")
        return Response.json({ status: "ok" }, { status: 200 });
      if (url.pathname === "/api/health/ready")
        return Response.json(
          {
            status: "ready",
            dependencies: {
              configuration: "ok",
              postgres: "ok",
              redis: "ok",
              storage: "ok",
            },
          },
          { status: 200 },
        );
      if (url.pathname === "/api/graphql") {
        const query = body ?? "";
        if (query.includes("SmokeQuery"))
          return Response.json(
            { errors: [{ message: "unauthenticated" }] },
            { status: 401 },
          );
        if (query.includes("SmokeViewer"))
          return Response.json(
            {
              data: {
                viewer: { id: workspaceId, workspace: { id: workspaceId } },
              },
            },
            { status: 200 },
          );
        if (query.includes("SmokeCreatePerson")) {
          syntheticDisplayName = JSON.parse(body ?? "{}").variables.input
            .displayName;
          return Response.json(
            {
              data: {
                createPerson: {
                  person: { id: personId, displayName: syntheticDisplayName },
                  code: "CREATED",
                },
              },
            },
            { status: 200 },
          );
        }
        if (query.includes("SmokePerson"))
          return Response.json(
            {
              data: {
                person: { id: personId, displayName: syntheticDisplayName },
              },
            },
            { status: 200 },
          );
      }
      if (url.pathname === "/api/jobs/run")
        return Response.json({ success: false }, { status: 401 });
      if (
        url.pathname === "/api/auth/sign-in/email" ||
        url.pathname === "/api/auth/sign-in/username"
      )
        return new Response("{}", {
          status: 200,
          headers: { "set-cookie": "humans.session=smoke; Path=/; HttpOnly" },
        });
      throw new Error(`unexpected smoke request ${url.pathname}`);
    };

    await runProductionSmoke({
      base: parseBaseUrl("https://humans.example.com"),
      auth: true,
      adminEmail: "admin@example.com",
      adminUsername: "humans-admin",
      adminPassword: "operator-password",
      fetchImpl,
      log: (line: string) => logs.push(line),
    });

    expect(
      requests
        .filter(({ path }) => path.startsWith("/api/auth/sign-in/"))
        .map(({ path, body }) => [path, JSON.parse(body ?? "{}")]),
    ).toEqual([
      [
        "/api/auth/sign-in/email",
        { email: "admin@example.com", password: "operator-password" },
      ],
      [
        "/api/auth/sign-in/username",
        { username: "humans-admin", password: "operator-password" },
      ],
    ]);
    expect(logs.join("\n")).not.toContain(workspaceId);
  });

  it("completes an explicitly requested TOTP challenge without logging the code", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const requests: Array<{
      path: string;
      body?: string;
      cookie?: string | null;
    }> = [];
    const logs: string[] = [];
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const personId = "00000000-0000-4000-8000-000000000002";
    const totp = "739201";
    let syntheticDisplayName = "";
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({
        path: url.pathname,
        body,
        cookie: headers.get("cookie"),
      });

      if (url.pathname === "/") return new Response("Humans", { status: 200 });
      if (url.pathname === "/api/health/live")
        return Response.json({ status: "ok" }, { status: 200 });
      if (url.pathname === "/api/health/ready")
        return Response.json(
          {
            status: "ready",
            dependencies: {
              configuration: "ok",
              postgres: "ok",
              redis: "ok",
              storage: "ok",
            },
          },
          { status: 200 },
        );
      if (url.pathname === "/api/jobs/run")
        return Response.json({ success: false }, { status: 401 });
      if (
        url.pathname === "/api/auth/sign-in/email" ||
        url.pathname === "/api/auth/sign-in/username"
      )
        return Response.json(
          { twoFactorRedirect: true },
          {
            status: 200,
            headers: {
              "set-cookie": "humans.two_factor=challenge; Path=/; HttpOnly",
            },
          },
        );
      if (url.pathname === "/api/auth/two-factor/verify-totp")
        return Response.json(
          { success: true },
          {
            status: 200,
            headers: {
              "set-cookie": "humans.session=verified; Path=/; HttpOnly",
            },
          },
        );
      if (url.pathname === "/api/graphql") {
        const query = body ?? "";
        if (query.includes("SmokeQuery"))
          return Response.json(
            { errors: [{ message: "unauthenticated" }] },
            { status: 401 },
          );
        if (query.includes("SmokeViewer"))
          return Response.json(
            {
              data: {
                viewer: { id: workspaceId, workspace: { id: workspaceId } },
              },
            },
            { status: 200 },
          );
        if (query.includes("SmokeCreatePerson")) {
          syntheticDisplayName = JSON.parse(body ?? "{}").variables.input
            .displayName;
          return Response.json(
            {
              data: {
                createPerson: {
                  person: { id: personId, displayName: syntheticDisplayName },
                  code: "CREATED",
                },
              },
            },
            { status: 200 },
          );
        }
        if (query.includes("SmokePerson"))
          return Response.json(
            {
              data: {
                person: { id: personId, displayName: syntheticDisplayName },
              },
            },
            { status: 200 },
          );
      }
      throw new Error(`unexpected smoke request ${url.pathname}`);
    };

    await runProductionSmoke({
      base: parseBaseUrl("https://humans.example.com"),
      auth: true,
      adminEmail: "admin@example.com",
      adminUsername: "humans-admin",
      adminPassword: "operator-password",
      fetchImpl,
      log: (line: string) => logs.push(line),
      twoFactor: true,
      totpCode: totp,
    });

    const challenge = requests.find(
      ({ path }) => path === "/api/auth/two-factor/verify-totp",
    );
    expect(JSON.parse(challenge?.body ?? "{}")).toEqual({
      code: totp,
      trustDevice: false,
    });
    expect(challenge?.cookie).toBe("humans.two_factor=challenge");
    expect(
      requests.find(
        ({ path, body }) =>
          path === "/api/graphql" && body?.includes("SmokeViewer"),
      )?.cookie,
    ).toContain("humans.session=verified");
    expect(logs.join("\n")).not.toContain(totp);
  });

  it("requires exactly one injected second factor when two-factor proof is requested", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");

    await expect(
      runProductionSmoke({
        base: parseBaseUrl("https://humans.example.com"),
        auth: true,
        adminEmail: "admin@example.com",
        adminUsername: "humans-admin",
        adminPassword: "operator-password",
        twoFactor: true,
        fetchImpl: async () => new Response("Humans", { status: 200 }),
        log: () => undefined,
      }),
    ).rejects.toThrow(/exactly one.*TOTP.*backup code/i);
  });

  it("reports external provider credential availability without returning values", async () => {
    const { externalProviderContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "provider-secret-that-must-not-escape";

    expect(
      externalProviderContractPlan({
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: secret,
        TEST_STORAGE_PROVIDER: "r2",
        TEST_STORAGE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        TEST_STORAGE_REGION: "auto",
        TEST_STORAGE_BUCKET: "humans-provider-contract",
        TEST_STORAGE_ACCESS_KEY_ID: "access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: secret,
      }),
    ).toEqual({
      enabled: ["upstash-rest", "r2"],
      unavailable: [],
    });

    let error: unknown;
    try {
      externalProviderContractPlan({
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      });
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/UPSTASH_REDIS_REST_TOKEN/);
    expect((error as Error).message).not.toContain("example.upstash.io");

    expect(() =>
      externalProviderContractPlan({
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        TEST_STORAGE_PROVIDER: "r2",
        TEST_STORAGE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        TEST_STORAGE_REGION: "auto",
        TEST_STORAGE_ACCESS_KEY_ID: "access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: secret,
      }),
    ).toThrow(/TEST_STORAGE_BUCKET/);
    expect(() =>
      externalProviderContractPlan({
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        TEST_STORAGE_PROVIDER: "unknown",
        TEST_STORAGE_ENDPOINT: "https://storage.example.test",
        TEST_STORAGE_REGION: "us-east-1",
        TEST_STORAGE_BUCKET: "humans-provider-contract",
        TEST_STORAGE_ACCESS_KEY_ID: "access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: secret,
      }),
    ).toThrow(/TEST_STORAGE_PROVIDER/);
  });

  it("runs only complete opted-in provider contracts and suppresses child output", async () => {
    const { runExternalProviderContracts } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "child-output-provider-secret";
    const logs: string[] = [];
    const executions: Array<{ RUN_EXTERNAL_PROVIDER_CONTRACTS?: string }> = [];

    await expect(
      runExternalProviderContracts({
        env: {
          RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
          UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
          UPSTASH_REDIS_REST_TOKEN: secret,
          ADMIN_PASSWORD: "unrelated-admin-secret",
          PATH: "/usr/bin",
        },
        execute: async (env: Record<string, string | undefined>) => {
          executions.push(env);
          return { exitCode: 0, output: secret };
        },
        log: (line: string) => logs.push(line),
      }),
    ).resolves.toEqual({ enabled: ["upstash-rest"], ran: true });

    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
      UPSTASH_REDIS_REST_TOKEN: secret,
      PATH: "/usr/bin",
    });
    expect(executions[0]).not.toHaveProperty("ADMIN_PASSWORD");
    expect(logs).toEqual([
      "external provider contracts passed for upstash-rest",
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);

    await expect(
      runExternalProviderContracts({
        env: {
          RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
          UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
          UPSTASH_REDIS_REST_TOKEN: secret,
        },
        execute: async () => ({ exitCode: 1, output: secret }),
        log: () => undefined,
      }),
    ).rejects.toThrow("external provider contracts failed for upstash-rest");

    await expect(
      runExternalProviderContracts({
        env: {},
        execute: async () => ({ exitCode: 0 }),
        log: () => undefined,
      }),
    ).rejects.toThrow(/explicit.*opt-in/i);
    await expect(
      runExternalProviderContracts({
        env: { RUN_EXTERNAL_PROVIDER_CONTRACTS: "true" },
        execute: async () => ({ exitCode: 0 }),
        log: () => undefined,
      }),
    ).rejects.toThrow(/no complete credential set/i);
  });

  it("rejects an HTTP-200 GraphQL error when reading the synthetic person", async () => {
    const { validateSyntheticPersonRead } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const response = Response.json(
      { errors: [{ message: "private provider detail" }] },
      {
        status: 200,
        headers: {
          "x-request-id": "00000000-0000-4000-8000-000000000004",
        },
      },
    );

    await expect(
      validateSyntheticPersonRead(response, {
        expectedId: "00000000-0000-4000-8000-000000000002",
        expectedDisplayName: "Production smoke 00000000",
      }),
    ).rejects.toThrow(/authenticated person read failed/);
  });

  it.each([
    ["wrong person", "00000000-0000-4000-8000-000000000003", "Expected"],
    ["wrong display name", "00000000-0000-4000-8000-000000000002", "Other"],
  ])("rejects an HTTP-200 %s read payload", async (_case, id, displayName) => {
    const { validateSyntheticPersonRead } =
      await import("../../scripts/production-readiness-smoke.mjs");

    await expect(
      validateSyntheticPersonRead(
        Response.json({ data: { person: { id, displayName } } }),
        {
          expectedId: "00000000-0000-4000-8000-000000000002",
          expectedDisplayName: "Expected",
        },
      ),
    ).rejects.toThrow(/authenticated person read failed/);
  });

  it("rejects a nominal readiness response that omits required dependency evidence", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    let call = 0;

    await expect(
      runProductionSmoke({
        base: parseBaseUrl("https://humans.example.com"),
        fetchImpl: async () => {
          call += 1;
          if (call === 1) return new Response("Humans", { status: 200 });
          if (call === 2)
            return Response.json({ status: "ok" }, { status: 200 });
          return Response.json({ status: "ready" }, { status: 200 });
        },
        log: () => undefined,
      }),
    ).rejects.toThrow(/dependency evidence/);
  });
});
