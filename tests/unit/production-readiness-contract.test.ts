import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const readRepositoryFile = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

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

  it("uses mode-0600, least-privilege operator templates for attended acceptance", () => {
    const closeout = readRepositoryFile(
      "docs/operations/production-closeout.md",
    );
    const docker = readRepositoryFile("docs/operations/docker.md");
    const authenticated = readRepositoryFile(
      "docs/operations/production-authenticated-smoke.op.env.example",
    );
    const recovery = readRepositoryFile(
      "docs/operations/production-operator.op.env.example",
    );
    const upstash = readRepositoryFile(
      "docs/operations/production-upstash-contracts.op.env.example",
    );
    const storage = readRepositoryFile(
      "docs/operations/production-storage-contracts.op.env.example",
    );
    const ai = readRepositoryFile(
      "docs/operations/production-ai-contracts.op.env.example",
    );
    const resend = readRepositoryFile(
      "docs/operations/production-resend-contracts.op.env.example",
    );

    expect(closeout).toContain(
      "install -m 600 docs/operations/production-authenticated-smoke.op.env.example .env.authenticated-smoke.op.tpl",
    );
    expect(docker).toContain(
      "install -m 600 docs/operations/production-operator.op.env.example .env.operator.op.tpl",
    );
    expect(authenticated).toContain("ADMIN_EMAIL=op://");
    expect(authenticated).toContain("ADMIN_USERNAME=op://");
    expect(authenticated).toContain("ADMIN_PASSWORD=op://");
    expect(authenticated).toContain("PRODUCTION_SMOKE_TOTP=op://");
    for (const unnecessaryVariable of [
      "DATABASE_URL=",
      "ADMIN_DISPLAY_NAME=",
      "UPSTASH_REDIS_REST_",
      "TEST_STORAGE_",
      "STORAGE_BUCKET=",
      "RUN_EXTERNAL_PROVIDER_CONTRACTS=",
    ])
      expect(authenticated).not.toContain(unnecessaryVariable);
    expect(recovery).toContain("DATABASE_URL=op://");
    expect(recovery).toContain("ADMIN_DISPLAY_NAME=op://");
    expect(recovery).not.toContain("RUN_EXTERNAL_PROVIDER_CONTRACTS=");
    expect(recovery).not.toContain("UPSTASH_REDIS_REST_");
    expect(recovery).not.toContain("TEST_STORAGE_");
    expect(upstash).toContain("UPSTASH_REDIS_REST_URL=op://");
    expect(upstash).toContain("UPSTASH_REDIS_REST_TOKEN=op://");
    expect(upstash).not.toContain("ADMIN_EMAIL=");
    expect(upstash).not.toContain("DATABASE_URL=");
    expect(upstash).not.toContain("TEST_STORAGE_");
    expect(storage).toContain("TEST_STORAGE_SECRET_ACCESS_KEY=op://");
    expect(storage).not.toContain("ADMIN_EMAIL=");
    expect(storage).not.toContain("DATABASE_URL=");
    expect(storage).not.toContain("UPSTASH_REDIS_REST_");
    expect(ai).toContain("TEST_AI_PROVIDER=op://");
    expect(ai).toContain("TEST_AI_API_KEY=op://");
    expect(ai).not.toContain("ADMIN_PASSWORD=");
    expect(ai).not.toContain("DATABASE_URL=");
    expect(ai).not.toContain("TEST_RESEND_");
    expect(resend).toContain("TEST_RESEND_API_KEY=op://");
    expect(resend).toContain("TEST_RESEND_RECIPIENT=op://");
    expect(resend).not.toContain("ADMIN_PASSWORD=");
    expect(resend).not.toContain("DATABASE_URL=");
    expect(resend).not.toContain("TEST_AI_");
  });

  it("parses only the explicit smoke switches", async () => {
    const { parseArgs } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(
      parseArgs([
        "--base-url",
        "https://example.invalid",
        "--authenticated",
        "--two-factor",
        "--provider-contracts",
        "--environment-contract",
      ]),
    ).toEqual({
      authenticated: true,
      baseUrl: "https://example.invalid",
      providerContracts: true,
      environmentContract: true,
      twoFactor: true,
    });
    expect(() => parseArgs(["--secret", "value"])).toThrow(/Unknown/);
  });

  it("reports the complete hosted environment contract using provider labels only", async () => {
    const { productionEnvironmentContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "hosted-environment-value-that-must-not-escape";

    const plan = productionEnvironmentContractPlan({
      DEPLOYMENT_MODE: "vercel",
      NEXT_PUBLIC_APP_URL: "https://humans.example.test",
      DATABASE_URL: secret,
      REDIS_URL: secret,
      KV_URL: secret,
      CRON_SECRET: secret,
      TRUSTED_PROXY_MODE: "vercel",
      AUTH_SECRET: secret,
      AUTH_ENCRYPTION_KEY: secret,
      DATA_ENCRYPTION_KEY: secret,
      PROTECTED_LOOKUP_HMAC_KEY: secret,
      OPERATION_LIMIT_HMAC_KEY: secret,
      AUTH_TRUSTED_ORIGINS: "https://humans.example.test",
      AUTH_SECURE_COOKIES: "true",
      ADMIN_EMAIL: "operator@example.test",
      ADMIN_USERNAME: "operator",
      ADMIN_DISPLAY_NAME: "Operator",
      ADMIN_PASSWORD: secret,
      RESEND_API_KEY: secret,
      EMAIL_FROM: "Humans <humans@example.test>",
      STORAGE_PROVIDER: "r2",
      STORAGE_ENDPOINT: "https://storage.example.test",
      STORAGE_REGION: "auto",
      STORAGE_BUCKET: "humans-private",
      STORAGE_ACCESS_KEY_ID: secret,
      STORAGE_SECRET_ACCESS_KEY: secret,
      STORAGE_FORCE_PATH_STYLE: "false",
      STORAGE_BUCKET_PUBLIC: "false",
      AI_PROVIDER: "compatible",
      AI_BASE_URL: "https://openrouter.ai/api/v1",
      AI_MODEL: "provider-model",
      OPEN_ROUTER_KEY: secret,
    });

    expect(plan).toEqual({
      configured: [
        "public-runtime",
        "authentication",
        "administrator-recovery",
        "upstash",
        "r2",
        "resend",
        "compatible",
      ],
      missing: {},
    });
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(JSON.stringify(plan)).not.toContain("humans.example.test");
    expect(JSON.stringify(plan)).not.toContain("operator@example.test");
  });

  it("reports only missing environment variable names for incomplete provider state", async () => {
    const {
      assertProductionEnvironmentContract,
      productionEnvironmentContractPlan,
    } = await import("../../scripts/production-readiness-smoke.mjs");
    const suppliedValue = "supplied-value-that-must-not-escape";
    const env = {
      AI_PROVIDER: "openai",
      AI_BASE_URL: "https://api.openai.com/v1",
      AI_MODEL: suppliedValue,
      EMAIL_FROM: "Humans <humans@example.test>",
    };

    const plan = productionEnvironmentContractPlan(env);
    expect(plan.missing.openai).toEqual(["AI_API_KEY", "OPENAI_API_KEY"]);
    expect(plan.missing.resend).toEqual(["RESEND_API_KEY"]);
    expect(JSON.stringify(plan)).not.toContain(suppliedValue);
    expect(JSON.stringify(plan)).not.toContain("humans@example.test");

    let error: unknown;
    try {
      assertProductionEnvironmentContract(env);
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("AI_API_KEY");
    expect((error as Error).message).toContain("OPENAI_API_KEY");
    expect((error as Error).message).toContain("RESEND_API_KEY");
    expect((error as Error).message).not.toContain(suppliedValue);
    expect((error as Error).message).not.toContain("humans@example.test");
  });

  it("treats Ollama as keyless while preserving its explicit provider contract", async () => {
    const { productionEnvironmentContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");

    const plan = productionEnvironmentContractPlan({
      AI_PROVIDER: "ollama",
      AI_BASE_URL: "http://ollama:11434/v1",
      AI_MODEL: "local-model",
    });

    expect(plan.missing.ollama).toBeUndefined();
    expect(plan.configured).toContain("ollama");
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

  it("fails missing authenticated configuration before network access without exposing supplied values", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const suppliedEmail = "operator@example.com";
    const suppliedUsername = "operator";
    let requests = 0;

    let error: unknown;
    try {
      await runProductionSmoke({
        base: parseBaseUrl("https://humans.example.com"),
        auth: true,
        adminEmail: suppliedEmail,
        adminUsername: suppliedUsername,
        adminPassword: "",
        fetchImpl: async () => {
          requests += 1;
          return new Response("unexpected", { status: 500 });
        },
        log: () => undefined,
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(requests).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ADMIN_PASSWORD");
    expect((error as Error).message).not.toContain(suppliedEmail);
    expect((error as Error).message).not.toContain(suppliedUsername);
  });

  it("contains transport failures without exposing credentials or URL values", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const password = "operator-password-that-must-not-escape";
    const credentialUrl = `https://operator:${password}@private.example.test/check?token=${password}`;

    let error: unknown;
    try {
      await runProductionSmoke({
        base: parseBaseUrl("https://humans.example.com"),
        fetchImpl: async () => {
          throw new Error(`transport failure for ${credentialUrl}`);
        },
        log: () => undefined,
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("request / failed");
    expect((error as Error).message).not.toContain(password);
    expect((error as Error).message).not.toContain(credentialUrl);
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
        TEST_STORAGE_BUCKET: "humans-contract-r2-acceptance",
        STORAGE_BUCKET: "humans-private",
        TEST_STORAGE_ACCESS_KEY_ID: "access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: secret,
      }),
    ).toEqual({
      enabled: ["upstash-rest", "r2"],
      unavailable: ["ai", "resend"],
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
        STORAGE_BUCKET: "humans-private",
        TEST_STORAGE_ACCESS_KEY_ID: "access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: secret,
      }),
    ).toThrow(/TEST_STORAGE_PROVIDER/);
  });

  it("plans opt-in AI and Resend contracts without exposing their configuration", async () => {
    const { externalProviderContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "external-contract-value-that-must-not-escape";

    const plan = externalProviderContractPlan({
      RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
      TEST_AI_PROVIDER: "openai",
      TEST_AI_BASE_URL: "https://api.openai.com/v1",
      TEST_AI_MODEL: "contract-model",
      TEST_AI_API_KEY: secret,
      TEST_RESEND_API_KEY: secret,
      TEST_RESEND_FROM: "Humans <humans@example.test>",
      TEST_RESEND_RECIPIENT: "acceptance@example.test",
    });

    expect(plan).toEqual({
      enabled: ["openai", "resend"],
      unavailable: ["upstash-rest", "storage"],
    });
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(JSON.stringify(plan)).not.toContain("acceptance@example.test");
  });

  it("normalizes Vercel Upstash REST aliases only inside the isolated child", async () => {
    const { runExternalProviderContracts } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "vercel-upstash-value-that-must-not-escape";
    const executions: Array<Record<string, string | undefined>> = [];

    await expect(
      runExternalProviderContracts({
        env: {
          RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
          UPSTASH_REDIS_REST_URL: "",
          UPSTASH_REDIS_REST_TOKEN: "",
          KV_REST_API_URL: "https://example.upstash.io",
          KV_REST_API_TOKEN: secret,
        },
        execute: async (env: Record<string, string | undefined>) => {
          executions.push(env);
          return { exitCode: 0 };
        },
        log: () => undefined,
      }),
    ).resolves.toEqual({ enabled: ["upstash-rest"], ran: true });

    expect(executions[0]).toMatchObject({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: secret,
    });
    expect(executions[0]).not.toHaveProperty("KV_REST_API_URL");
    expect(executions[0]).not.toHaveProperty("KV_REST_API_TOKEN");
  });

  it("does not let empty canonical Upstash values skip the real child contract", async () => {
    const { runExternalProviderContracts } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "upstash-contract-token-that-must-not-escape";
    const logs: string[] = [];

    let error: unknown;
    try {
      await runExternalProviderContracts({
        env: {
          RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
          UPSTASH_REDIS_REST_URL: "",
          UPSTASH_REDIS_REST_TOKEN: "",
          KV_REST_API_URL: "http://127.0.0.1:1",
          KV_REST_API_TOKEN: secret,
          PATH: process.env.PATH,
        },
        log: (line: string) => logs.push(line),
      });
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "external provider contracts failed for upstash-rest",
    );
    expect(logs).toEqual([]);
    expect((error as Error).message).not.toContain(secret);
  }, 20_000);

  it("runs the opted-in AI and Resend adapters against controlled provider boundaries", async () => {
    const { runExternalProviderContracts } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/chat/completions") {
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    answer: "Provider contract accepted.",
                    citations: [],
                  }),
                },
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/emails") {
        response.end(JSON.stringify({ id: "controlled-provider-message" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const providerSecret = "controlled-provider-secret";
    const logs: string[] = [];

    try {
      await expect(
        runExternalProviderContracts({
          env: {
            RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
            TEST_AI_PROVIDER: "ollama",
            TEST_AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
            TEST_AI_MODEL: "controlled-model",
            TEST_RESEND_API_KEY: providerSecret,
            TEST_RESEND_FROM: "Humans <humans@example.test>",
            TEST_RESEND_RECIPIENT: "acceptance@example.test",
            TEST_RESEND_BASE_URL: `http://127.0.0.1:${port}`,
            PATH: process.env.PATH,
          },
          log: (line: string) => logs.push(line),
        }),
      ).resolves.toEqual({ enabled: ["ollama", "resend"], ran: true });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(requests.sort()).toEqual(["/emails", "/v1/chat/completions"]);
    expect(logs).toEqual([
      "external provider contracts passed for ollama, resend",
    ]);
    expect(JSON.stringify(logs)).not.toContain(providerSecret);
  }, 20_000);

  it("fails closed on an external storage bucket that is not isolated before a provider suite can run", async () => {
    const { externalProviderContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const secret = "external-storage-secret-that-must-not-escape";
    const endpoint = "https://private-account.r2.cloudflarestorage.com";

    for (const testStorageBucket of [
      "humans-private",
      "humans-contract-private",
      "humans-contract-application",
      "humans-contract-shared",
    ]) {
      let error: unknown;
      try {
        externalProviderContractPlan({
          RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
          STORAGE_BUCKET:
            testStorageBucket === "humans-contract-shared"
              ? "humans-contract-shared"
              : "humans-application-data",
          TEST_STORAGE_PROVIDER: "r2",
          TEST_STORAGE_ENDPOINT: endpoint,
          TEST_STORAGE_REGION: "auto",
          TEST_STORAGE_BUCKET: testStorageBucket,
          TEST_STORAGE_ACCESS_KEY_ID: "contract-access-key",
          TEST_STORAGE_SECRET_ACCESS_KEY: secret,
        });
      } catch (candidate) {
        error = candidate;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /isolated contract-test bucket/i,
      );
      expect((error as Error).message).not.toContain(testStorageBucket);
      expect((error as Error).message).not.toContain(endpoint);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("accepts only a distinct external contract-test bucket", async () => {
    const { externalProviderContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");

    expect(
      externalProviderContractPlan({
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        STORAGE_BUCKET: "humans-private",
        TEST_STORAGE_PROVIDER: "s3",
        TEST_STORAGE_ENDPOINT: "https://s3.example.test",
        TEST_STORAGE_REGION: "us-east-1",
        TEST_STORAGE_BUCKET: "humans-contract-s3-acceptance",
        TEST_STORAGE_ACCESS_KEY_ID: "contract-access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: "contract-secret",
      }),
    ).toEqual({
      enabled: ["s3"],
      unavailable: ["upstash-rest", "ai", "resend"],
    });
  });

  it("keeps local MinIO contract planning independent of an application bucket", async () => {
    const { externalProviderContractPlan } =
      await import("../../scripts/production-readiness-smoke.mjs");

    expect(
      externalProviderContractPlan({
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        TEST_STORAGE_PROVIDER: "minio",
        TEST_STORAGE_ENDPOINT: "http://minio.internal:9000",
        TEST_STORAGE_REGION: "us-east-1",
        TEST_STORAGE_BUCKET: "humans-provider-contract",
        TEST_STORAGE_ACCESS_KEY_ID: "local-access-key",
        TEST_STORAGE_SECRET_ACCESS_KEY: "local-secret",
      }),
    ).toEqual({
      enabled: ["minio"],
      unavailable: ["upstash-rest", "ai", "resend"],
    });
  });

  it("does not start a provider child suite when storage isolation is unsafe", async () => {
    const { runExternalProviderContracts } =
      await import("../../scripts/production-readiness-smoke.mjs");
    let executed = false;

    await expect(
      runExternalProviderContracts({
        env: {
          RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
          STORAGE_BUCKET: "humans-private",
          TEST_STORAGE_PROVIDER: "r2",
          TEST_STORAGE_ENDPOINT: "https://private.example.test",
          TEST_STORAGE_REGION: "auto",
          TEST_STORAGE_BUCKET: "humans-contract-private",
          TEST_STORAGE_ACCESS_KEY_ID: "contract-access-key",
          TEST_STORAGE_SECRET_ACCESS_KEY: "contract-secret",
        },
        execute: async () => {
          executed = true;
          return { exitCode: 0 };
        },
        log: () => undefined,
      }),
    ).rejects.toThrow(/isolated contract-test bucket/i);
    expect(executed).toBe(false);
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
