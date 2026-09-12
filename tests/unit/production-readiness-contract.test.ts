import { describe, expect, it } from "vitest";

describe("production readiness smoke contract", () => {
  it("rejects missing, credential-bearing, and non-http URLs", async () => {
    const { parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(() => parseBaseUrl("")).toThrow(/base-url/);
    expect(() => parseBaseUrl("ftp://example.invalid")).toThrow(/HTTP/);
    expect(() => parseBaseUrl("https://user:pass@example.invalid")).toThrow(
      /credential-free/,
    );
  });

  it("parses only the explicit smoke switches", async () => {
    const { parseArgs } =
      await import("../../scripts/production-readiness-smoke.mjs");
    expect(
      parseArgs([
        "--base-url",
        "https://example.invalid",
        "--provider-contracts",
      ]),
    ).toEqual({
      baseUrl: "https://example.invalid",
      providerContracts: true,
    });
    expect(() => parseArgs(["--secret", "value"])).toThrow(/Unknown/);
  });

  it("never includes response bodies or credentials in its observable error shape", async () => {
    const { runProductionSmoke, parseBaseUrl } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const logs: string[] = [];
    await expect(
      runProductionSmoke({
        base: parseBaseUrl("https://example.invalid"),
        log: (line: string) => {
          logs.push(line);
        },
        fetchImpl: async () =>
          new Response(JSON.stringify({ secret: "do-not-print" }), {
            status: 500,
          }),
      }),
    ).rejects.toThrow(/homepage returned 500/);
    expect(logs.join("\n")).not.toContain("do-not-print");
  });
});
