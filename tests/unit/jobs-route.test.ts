import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  POST,
  createJobsRunHandler,
  maxDuration,
  runtime,
} from "@/app/api/jobs/run/route";

const secret = "Cron!N7vQ2xL9mR4tK8wP5sD3cF6hJ0bE";

describe("bounded Vercel job route", () => {
  it("accepts only the exact bearer secret and returns the bounded summary", async () => {
    const run = vi.fn(async () => ({
      claimed: 2,
      completed: 1,
      deadLettered: 0,
      deferred: 1,
    }));
    const handler = createJobsRunHandler({ getSecret: () => secret, run });

    const response = await handler(
      new Request("https://humans.example/api/jobs/run", {
        headers: { authorization: `Bearer ${secret}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: {
        claimed: 2,
        completed: 1,
        deadLettered: 0,
        deferred: 1,
      },
      requestId: expect.any(String),
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", "Bearer wrong", `bearer ${secret}`])(
    "rejects a missing or non-exact authorization value",
    async (authorization) => {
      const run = vi.fn(async () => ({
        claimed: 0,
        completed: 0,
        deadLettered: 0,
        deferred: 0,
      }));
      const handler = createJobsRunHandler({ getSecret: () => secret, run });
      const headers = authorization ? { authorization } : undefined;
      const response = await handler(
        new Request("https://humans.example/api/jobs/run", { headers }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        code: "UNAUTHENTICATED",
        requestId: expect.any(String),
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("fails closed without exposing configuration or executor errors", async () => {
    const configurationFailure = createJobsRunHandler({
      getSecret: () => {
        throw new Error("private configuration details");
      },
      run: vi.fn(),
    });
    const executionFailure = createJobsRunHandler({
      getSecret: () => secret,
      run: async () => {
        throw new Error("private database details");
      },
    });
    const request = new Request("https://humans.example/api/jobs/run", {
      headers: { authorization: `Bearer ${secret}` },
    });

    for (const handler of [configurationFailure, executionFailure]) {
      const response = await handler(request);
      expect(response.status).toBe(503);
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
      expect(await response.json()).toMatchObject({
        success: false,
        code: "INTERNAL",
        requestId: expect.any(String),
      });
    }
  });

  it("uses a bounded Node runtime and closes POST", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(30);
    const response = POST(new Request("https://humans.example/api/jobs/run"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("registers the protected batch endpoint in Vercel configuration", () => {
    const configuration = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(configuration.crons).toEqual([
      { path: "/api/jobs/run", schedule: "*/5 * * * *" },
    ]);
    expect(readFileSync(".env.example", "utf8")).toContain(
      "CRON_SECRET=replace-with-an-independent-strong-cron-secret",
    );
  });

  it("routes Docker and one-shot commands through the shared runtime", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts.worker).toBe(
      "node --conditions react-server --import tsx src/worker/run-continuous.ts",
    );
    expect(scripts["jobs:run-once"]).toBe(
      "node --conditions react-server --import tsx src/worker/run-bounded.ts",
    );
    expect(() => readFileSync("docker/entrypoint.sh", "utf8")).toThrow();
    expect(readFileSync("src/worker/run-bounded.ts", "utf8")).toContain(
      "process.exit(0)",
    );
    expect(readFileSync("src/worker/run-continuous.ts", "utf8")).toContain(
      "process.exit(0)",
    );
    expect(readFileSync("docker-compose.yml", "utf8")).toMatch(
      /^  worker:[\s\S]*?command: \["--conditions=react-server", "runtime\/worker\.mjs"\]/mu,
    );
  });
});
