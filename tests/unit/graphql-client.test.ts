import { afterEach, describe, expect, it, vi } from "vitest";

import { executeBrowserGraphQL } from "@/graphql/client";
import { ResearchViewerDocument } from "@/graphql/generated/graphql";

describe("executeBrowserGraphQL", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the response request ID on successful payloads", async () => {
    const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { viewer: null } }), {
          headers: { "x-request-id": requestId },
        }),
      ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({
      ok: true,
      data: { viewer: null },
      requestId,
    });
  });

  it("drops malformed response request IDs when JSON is unreadable", async () => {
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
        },
      ],
    });
  });

  it("does not expose a malformed response ID on a successful payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { viewer: null } }), {
          headers: { "x-request-id": "not-a-request-id" },
        }),
      ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({ ok: true, data: { viewer: null } });
  });

  it("uses the response header as the correlation source and masks unknown errors", async () => {
    const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";
    const secret = "database-password-and-private-prompt";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: secret,
                extensions: {
                  code: "UNEXPECTED_PROVIDER_ERROR",
                  requestId: "01984e93-7644-72c6-82d0-fda7f590581f",
                },
              },
            ],
          }),
          { headers: { "x-request-id": requestId }, status: 500 },
        ),
      ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: "INTERNAL",
          message: "An internal error occurred.",
          requestId,
        },
      ],
    });
  });

  it("uses a valid error extension ID when the response header is malformed", async () => {
    const extensionRequestId = "01984e93-7644-72c6-82d0-fda7f590581f";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: "not-found detail that must be bounded",
                extensions: {
                  code: "NOT_FOUND",
                  requestId: extensionRequestId,
                },
              },
            ],
          }),
          {
            headers: { "x-request-id": "malformed-response-header" },
            status: 404,
          },
        ),
      ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: "NOT_FOUND",
          message: "The requested resource was not found.",
          requestId: extensionRequestId,
        },
      ],
    });
  });

  it("contains null and malformed error entries while preserving the header ID", async () => {
    const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ errors: [null, "private password", []] }),
            { headers: { "x-request-id": requestId }, status: 500 },
          ),
        ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: "INTERNAL",
          message: "An internal error occurred.",
          requestId,
        },
        {
          code: "INTERNAL",
          message: "An internal error occurred.",
          requestId,
        },
        {
          code: "INTERNAL",
          message: "An internal error occurred.",
          requestId,
        },
      ],
    });
  });

  it("rejects a non-array errors field instead of treating data as success", async () => {
    const requestId = "01984e93-7644-72c6-82d0-fda7f590580e";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: { viewer: null }, errors: "malformed" }),
            { headers: { "x-request-id": requestId } },
          ),
        ),
    );

    await expect(
      executeBrowserGraphQL(ResearchViewerDocument, {}),
    ).resolves.toEqual({
      ok: false,
      errors: [
        {
          code: "INTERNAL",
          message: "An internal error occurred.",
          requestId,
        },
      ],
    });
  });
});
