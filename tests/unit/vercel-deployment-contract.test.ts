import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { clientEnvSchema } from "@/lib/env/client";

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

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("local smoke server did not expose a TCP address");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const requestId =
    typeof body === "object" && body !== null && "requestId" in body
      ? String(body.requestId)
      : undefined;
  response.writeHead(status, {
    "content-type": "application/json",
    ...(requestId ? { "x-request-id": requestId } : {}),
  });
  response.end(JSON.stringify(body));
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
      'output: "standalone"',
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
    const { server, url } = await listen((request, response) => {
      requests.push({
        authorization: request.headers.authorization ?? null,
        path: request.url ?? "",
      });
      if (request.url === "/api/health/live") {
        json(response, 200, { status: "ok" });
      } else if (request.url === "/api/health/ready") {
        json(response, 200, { status: "ready" });
      } else if (request.url === "/api/graphql") {
        json(response, 401, { errors: [{ message: "unauthenticated" }] });
      } else if (request.url === "/api/jobs/run") {
        json(response, 401, {
          success: false,
          code: "UNAUTHENTICATED",
          requestId: "018f0000-0000-7000-8000-000000000001",
        });
      } else {
        json(response, 404, { error: "not found" });
      }
    });

    try {
      const result = await runSmoke({ VERCEL_SMOKE_URL: url });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Vercel smoke passed for");
      expect(requests).toEqual([
        { path: "/api/health/live", authorization: null },
        { path: "/api/health/ready", authorization: null },
        { path: "/api/graphql", authorization: null },
        { path: "/api/jobs/run", authorization: "Bearer invalid" },
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("passes the exact optional cron credential only to the protected job route", async () => {
    const cronSecret = "local-smoke-cron-secret";
    const requests: Array<{ authorization: string | null; path: string }> = [];
    const { server, url } = await listen((request, response) => {
      requests.push({
        authorization: request.headers.authorization ?? null,
        path: request.url ?? "",
      });
      if (request.url === "/api/health/live") {
        json(response, 200, { status: "ok" });
      } else if (request.url === "/api/health/ready") {
        json(response, 200, { status: "ready" });
      } else if (request.url === "/api/graphql") {
        json(response, 403, { errors: [{ message: "forbidden" }] });
      } else if (
        request.url === "/api/jobs/run" &&
        request.headers.authorization === "Bearer invalid"
      ) {
        json(response, 401, {
          success: false,
          code: "UNAUTHENTICATED",
          requestId: "018f0000-0000-7000-8000-000000000002",
        });
      } else if (
        request.url === "/api/jobs/run" &&
        request.headers.authorization === `Bearer ${cronSecret}`
      ) {
        json(response, 200, {
          success: true,
          summary: { claimed: 0, completed: 0, deadLettered: 0, deferred: 0 },
          requestId: "018f0000-0000-7000-8000-000000000003",
        });
      } else {
        json(response, 403, { success: false });
      }
    });

    try {
      const result = await runSmoke({
        VERCEL_SMOKE_URL: url,
        VERCEL_SMOKE_CRON_SECRET: cronSecret,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Vercel smoke passed for");
      expect(requests.at(-1)).toEqual({
        path: "/api/jobs/run",
        authorization: `Bearer ${cronSecret}`,
      });
      expect(
        requests
          .filter(({ path }) => path === "/api/jobs/run")
          .map(({ authorization }) => authorization),
      ).toEqual(["Bearer invalid", `Bearer ${cronSecret}`]);
    } finally {
      await closeServer(server);
    }
  });
});
