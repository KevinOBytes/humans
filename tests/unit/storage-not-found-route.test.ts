import { describe, expect, it } from "vitest";

import { GET, PUT } from "@/app/api/storage/objects/[...path]/route";

const requestId = "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1";

describe("unmatched storage object route", () => {
  it.each([GET, PUT])(
    "returns a correlated stable not-found envelope",
    async (handler) => {
      const response = await handler(
        new Request("https://humans.example/api/storage/objects/unknown", {
          headers: { "x-request-id": requestId },
        }),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-request-id")).toBe(
        requestId.toLowerCase(),
      );
      await expect(response.json()).resolves.toEqual({
        status: "error",
        code: "NOT_FOUND",
        requestId: requestId.toLowerCase(),
      });
    },
  );
});
