import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { clientEnvSchema } from "@/lib/env/client";
import {
  parseSmokeConfig,
  runSmoke as runSmokeTransport,
} from "../../scripts/vercel-deployment-smoke-lib.mjs";

type SmokeResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};
type SmokeOverrides = Record<string, string | undefined>;

const smokeScript = "scripts/vercel-deployment-smoke.mjs";

function smokeEnvironment(overrides: SmokeOverrides = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "VERCEL_SMOKE_URL",
    "VERCEL_URL",
    "VERCEL_SMOKE_CRON_SECRET",
    "VERCEL_SMOKE_TIMEOUT_MS",
  ]) {
    delete environment[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function runSmoke(overrides: SmokeOverrides = {}): Promise<SmokeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript], {
      cwd: process.cwd(),
      env: smokeEnvironment(overrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stderr, stdout }));
  });
}

describe("Vercel deployment parity contract", () => {
  it("keeps the Next build and bounded cron configuration explicit", () => {
    const configuration = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      $schema?: string;
      builds?: unknown;
      buildCommand?: unknown;
      outputDirectory?: unknown;
      crons?: unknown;
    };
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      engines?: { node?: string };
      scripts?: { build?: string };
    };

    expect(configuration.$schema).toBe("https://openapi.vercel.sh/vercel.json");
    expect(configuration.crons).toEqual([
      { path: "/api/jobs/run", schedule: "*/5 * * * *" },
    ]);
    expect(configuration).not.toHaveProperty("builds");
    expect(configuration).not.toHaveProperty("buildCommand");
    expect(configuration).not.toHaveProperty("outputDirectory");
    expect(packageJson.engines?.node).toBe("24.x");
    expect(packageJson.scripts?.build).toBe("next build");
    expect(readFileSync("next.config.ts", "utf8")).toContain(
      'output: process.env.VERCEL ? undefined : "standalone"',
    );
  });

  it("does not return server secrets through the public environment schema", () => {
    const parsed = clientEnvSchema.parse({
      NEXT_PUBLIC_APP_URL: "https://humans.example.com",
      AUTH_SECRET: "server-only-secret",
      DATABASE_URL: "postgresql://server-only",
    });

    expect(parsed).toEqual({
      NEXT_PUBLIC_APP_URL: "https://humans.example.com",
    });
    expect(parsed).not.toHaveProperty("AUTH_SECRET");
    expect(parsed).not.toHaveProperty("DATABASE_URL");
    expect(readFileSync("src/lib/env/server.ts", "utf8")).toContain(
      'import "server-only"',
    );
  });

  it("skips without a deployment URL instead of pretending a hosted check ran", async () => {
    const result = await runSmoke();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Vercel smoke skipped: set VERCEL_SMOKE_URL (or VERCEL_URL)",
    );
    expect(result.stderr).toBe("");
  });

  it("fails closed for malformed deployment URLs and unsafe secret transport", async () => {
    await expect(
      runSmoke({ VERCEL_SMOKE_URL: "file:///tmp/humans-smoke" }),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(
        "Vercel smoke requires a valid HTTP(S) deployment URL",
      ),
    });

    await expect(
      runSmoke({
        VERCEL_SMOKE_URL: "http://example.com",
        VERCEL_SMOKE_CRON_SECRET: "test-cron-secret",
      }),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining(
        "requires an HTTPS deployment URL outside loopback",
      ),
    });
  });

  it("runs reachability and unauthenticated boundaries without an optional cron credential", async () => {
    const requests: Array<{ authorization: string | null; path: string }> = [];
    const config = parseSmokeConfig({
      ...process.env,
      VERCEL_SMOKE_URL: "https://smoke.example.test",
    });
    const fetchImpl = async (
      input: Parameters<typeof fetch>[0],
      init: RequestInit = {},
    ) => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      requests.push({
        authorization: new Headers(init.headers).get("authorization"),
        path,
      });
      const bodies: Record<
        string,
        { status: number; body: unknown; requestId?: string }
      > = {
        "/api/health/live": { status: 200, body: { status: "ok" } },
        "/api/health/ready": { status: 200, body: { status: "ready" } },
        "/api/graphql": {
          status: 401,
          body: { errors: [{ message: "unauthenticated" }] },
        },
        "/api/jobs/run": {
          status: 401,
          body: {
            success: false,
            code: "UNAUTHENTICATED",
            requestId: "018f0000-0000-7000-8000-000000000001",
          },
          requestId: "018f0000-0000-7000-8000-000000000001",
        },
      };
      const result = bodies[path];
      if (!result)
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: result.requestId
          ? { "x-request-id": result.requestId }
          : undefined,
      });
    };
    await runSmokeTransport({ ...config!, fetchImpl });
    expect(requests).toEqual([
      { path: "/api/health/live", authorization: null },
      { path: "/api/health/ready", authorization: null },
      { path: "/api/graphql", authorization: null },
      { path: "/api/jobs/run", authorization: "Bearer invalid" },
    ]);
  });

  it("passes the exact optional cron credential only to the protected job route", async () => {
    const cronSecret = "local-smoke-cron-secret";
    const requests: Array<{ authorization: string | null; path: string }> = [];
    const config = parseSmokeConfig({
      ...process.env,
      VERCEL_SMOKE_URL: "https://smoke.example.test",
      VERCEL_SMOKE_CRON_SECRET: cronSecret,
    });
    const fetchImpl = async (
      input: Parameters<typeof fetch>[0],
      init: RequestInit = {},
    ) => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      const authorization = new Headers(init.headers).get("authorization");
      requests.push({ path, authorization });
      if (path === "/api/health/live") {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (path === "/api/health/ready") {
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
        });
      }
      if (path === "/api/graphql") {
        return new Response(
          JSON.stringify({ errors: [{ message: "forbidden" }] }),
          { status: 403 },
        );
      }
      if (authorization === "Bearer invalid") {
        return new Response(
          JSON.stringify({
            success: false,
            code: "UNAUTHENTICATED",
            requestId: "018f0000-0000-7000-8000-000000000002",
          }),
          {
            status: 401,
            headers: { "x-request-id": "018f0000-0000-7000-8000-000000000002" },
          },
        );
      }
      if (authorization === `Bearer ${cronSecret}`) {
        return new Response(
          JSON.stringify({
            success: true,
            summary: { claimed: 0, completed: 0, deadLettered: 0, deferred: 0 },
            requestId: "018f0000-0000-7000-8000-000000000003",
          }),
          {
            status: 200,
            headers: { "x-request-id": "018f0000-0000-7000-8000-000000000003" },
          },
        );
      }
      return new Response(JSON.stringify({ success: false }), { status: 403 });
    };
    await runSmokeTransport({ ...config!, fetchImpl });
    expect(requests.at(-1)).toEqual({
      path: "/api/jobs/run",
      authorization: `Bearer ${cronSecret}`,
    });
    expect(
      requests
        .filter(({ path }) => path === "/api/jobs/run")
        .map(({ authorization }) => authorization),
    ).toEqual(["Bearer invalid", `Bearer ${cronSecret}`]);
  });
});
