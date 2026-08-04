import { afterEach, describe, expect, it, vi } from "vitest";

import { executeBrowserGraphQL } from "@/graphql/client";
import { ResearchViewerDocument } from "@/graphql/generated/graphql";

describe("executeBrowserGraphQL", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the response request ID on successful payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { viewer: null } }), {
          headers: { "x-request-id": "request-success" },
        }),
      ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({
      ok: true,
      data: { viewer: null },
      requestId: "request-success",
    });
  });

  it("preserves the response request ID when JSON is unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json", {
          headers: { "x-request-id": "request-invalid-json" },
        }),
      ),
    );

    const result = await executeBrowserGraphQL(ResearchViewerDocument, {});
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "INVALID_RESPONSE",
          message: "The server returned an unreadable response.",
          requestId: "request-invalid-json",
        },
      ],
    });
  });
});
