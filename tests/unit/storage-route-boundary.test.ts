// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createStorageRouteHandlers } from "@/app/api/storage/objects/handlers";

const requestId = "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1";

describe("storage route boundary", () => {
  it("contains initialization failures with a correlated stable error", async () => {
    const logger = { log: vi.fn() };
    const handlers = createStorageRouteHandlers(async () => {
      throw new Error("database password=secret");
    }, logger);

    const response = await handlers.GET(
      new Request("https://humans.example/api/storage/objects", {
        headers: { "x-request-id": requestId },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe(requestId.toLowerCase());
    const serialized = await response.text();
    expect(serialized).not.toContain("secret");
    expect(JSON.parse(serialized)).toEqual({
      status: "error",
      code: "INTERNAL",
      requestId: requestId.toLowerCase(),
    });
    expect(logger.log).toHaveBeenCalledWith({
      event: "storage.infrastructure.failure",
      requestId: requestId.toLowerCase(),
      severity: "error",
    });
  });

  it("evicts a rejected initialization so a later request can recover", async () => {
    let attempts = 0;
    const delegate = vi.fn(async () => Response.json({ status: true }));
    const handlers = createStorageRouteHandlers(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary provider failure");
      return { GET: delegate, PUT: delegate };
    });

    await expect(
      handlers.GET(new Request("https://humans.example/api/storage/objects")),
    ).resolves.toHaveProperty("status", 503);
    await expect(
      handlers.GET(new Request("https://humans.example/api/storage/objects")),
    ).resolves.toHaveProperty("status", 200);

    expect(attempts).toBe(2);
    expect(delegate).toHaveBeenCalledOnce();
  });
});
