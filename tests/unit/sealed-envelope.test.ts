import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";

const key = "ab".repeat(32);

describe("purpose-bound sealed envelopes", () => {
  it("round trips only for the same purpose", () => {
    const token = sealEnvelope({
      key,
      plaintext: JSON.stringify({ operation: "upload" }),
      purpose: "storage-upload",
    });
    expect(openSealedEnvelope({ key, purpose: "storage-upload", token })).toBe(
      '{"operation":"upload"}',
    );
    expect(() =>
      openSealedEnvelope({ key, purpose: "storage-download", token }),
    ).toThrow(/open/i);
  });

  it("is guarded by the server-only boundary", async () => {
    vi.resetModules();
    vi.doUnmock("server-only");
    await expect(import("@/lib/security/sealed-envelope")).rejects.toThrow(
      /only be used from a Server Component/i,
    );
    vi.doMock("server-only", () => ({}));
  });

  it("rejects tampering, non-canonical encoding, and oversized material", () => {
    const token = sealEnvelope({ key, plaintext: "safe", purpose: "job" });
    expect(() =>
      openSealedEnvelope({
        key,
        purpose: "job",
        token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
      }),
    ).toThrow(/open/i);
    expect(() =>
      sealEnvelope({ key, plaintext: "x".repeat(65_537), purpose: "job" }),
    ).toThrow(/seal/i);
  });
});
