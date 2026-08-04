import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET as getLiveness } from "@/app/api/health/live/route";
import { createReadinessHandler } from "@/app/api/health/ready/route";

describe("liveness", () => {
  it("returns a non-secret status", async () => {
    const response = await getLiveness();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "humans" });
  });
});

describe("readiness", () => {
  it("reports each successful required dependency", async () => {
    const getReadiness = createReadinessHandler([
      { name: "configuration", check: async () => undefined },
      { name: "postgres", check: async () => undefined },
      { name: "redis", check: async () => undefined },
      { name: "storage", check: async () => undefined },
    ]);

    const response = await getReadiness();

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

    const response = await getReadiness();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "unavailable",
      service: "humans",
      dependencies: { configuration: "ok", redis: "failed" },
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
    const response = await getReadiness();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(80);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      service: "humans",
      dependencies: { storage: "failed" },
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

    const response = await getReadiness();
    rejectProbe?.(new Error("late secret-bearing rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(503);
  });
});
