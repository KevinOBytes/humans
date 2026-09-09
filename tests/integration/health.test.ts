import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as getLiveness } from "@/app/api/health/live/route";
import {
  createReadinessHandler,
  retryReadinessCheck,
} from "@/app/api/health/ready/handler";

describe("liveness", () => {
  it("returns a non-secret status", async () => {
    const request = new Request("http://localhost/api/health/live", {
      headers: { "x-request-id": "019fe224-a0cd-76e4-92ac-9d28795c2cca" },
    });
    const response = await getLiveness(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "humans",
      requestId: "019fe224-a0cd-76e4-92ac-9d28795c2cca",
    });
    expect(response.headers.get("x-request-id")).toBe(
      "019fe224-a0cd-76e4-92ac-9d28795c2cca",
    );
  });
});

describe("readiness", () => {
  it("retries a dependency check after a transient connection failure", async () => {
    let attempts = 0;

    await expect(
      retryReadinessCheck(
        async () => {
          attempts += 1;
          if (attempts < 2) throw new Error("connection reset");
        },
        { delayMs: 0 },
      ),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(2);
  });

  it("reports each successful required dependency", async () => {
    const getReadiness = createReadinessHandler([
      { name: "configuration", check: async () => undefined },
      { name: "postgres", check: async () => undefined },
      { name: "redis", check: async () => undefined },
      { name: "storage", check: async () => undefined },
    ]);

    const request = new Request("http://localhost/api/health/ready", {
      headers: { "x-request-id": "019fe224-a0cd-76e4-92ac-9d28795c2cca" },
    });
    const response = await getReadiness(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      service: "humans",
      dependencies: {
        configuration: "ok",
        postgres: "ok",
        redis: "ok",
        storage: "ok",
      },
      requestId: "019fe224-a0cd-76e4-92ac-9d28795c2cca",
    });
  });

  it("identifies failed dependencies without exposing connection details", async () => {
    const getReadiness = createReadinessHandler([
      { name: "configuration", check: async () => undefined },
      {
        name: "redis",
        check: async () => {
          throw new Error(
            "connect ECONNREFUSED redis://default:super-secret@redis:6379",
          );
        },
      },
    ]);

    const response = await getReadiness(
      new Request("http://localhost/api/health/ready"),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "unavailable",
      service: "humans",
      dependencies: { configuration: "ok", redis: "failed" },
      requestId: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("super-secret");
    expect(JSON.stringify(body)).not.toContain("redis://");
  });

  it("returns a fixed failure before a dependency deadline", async () => {
    const getReadiness = createReadinessHandler(
      [
        {
          name: "storage",
          check: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
          },
        },
      ],
      { timeoutMs: 10 },
    );

    const startedAt = performance.now();
    const response = await getReadiness(
      new Request("http://localhost/api/health/ready"),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(80);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      service: "humans",
      dependencies: { storage: "failed" },
      requestId: expect.any(String),
    });
  });

  it("consumes late probe rejection after returning a timeout", async () => {
    let rejectProbe: ((error: Error) => void) | undefined;
    const getReadiness = createReadinessHandler(
      [
        {
          name: "storage",
          check: () =>
            new Promise<void>((_, reject) => {
              rejectProbe = reject;
            }),
        },
      ],
      { timeoutMs: 5 },
    );

    const response = await getReadiness(
      new Request("http://localhost/api/health/ready"),
    );
    rejectProbe?.(new Error("late secret-bearing rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(503);
  });
});
