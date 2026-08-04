import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { canonicalizeHttpOrigin } from "@/lib/security/http-origin.server";

describe("canonicalizeHttpOrigin", () => {
  afterEach(() => {
    vi.doMock("server-only", () => ({}));
    vi.resetModules();
  });

  it.each([
    ["carriage return", "https://exa\rmple.example/path"],
    ["line feed", "https://exa\nmple.example/path"],
    ["tab", "https://exa\tmple.example/path"],
    ["NUL", "https://example.test/\u0000path"],
    ["DEL", "https://example.test/\u007fpath"],
  ])("rejects %s controls before URL parsing", (_case, value) => {
    expect(canonicalizeHttpOrigin(value)).toBeNull();
  });

  it.each([
    "https://@example.test/path",
    "https://user@example.test/path",
    "https://user:password@example.test/path",
  ])("rejects authority userinfo in %s", (value) => {
    expect(canonicalizeHttpOrigin(value)).toBeNull();
  });

  it("is guarded by the server-only boundary", async () => {
    vi.resetModules();
    vi.doUnmock("server-only");

    await expect(import("@/lib/security/http-origin.server")).rejects.toThrow(
      /only be used from a Server Component/i,
    );
  });
});
