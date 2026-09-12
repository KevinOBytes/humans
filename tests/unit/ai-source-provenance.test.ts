import { describe, expect, it } from "vitest";
import {
  assertImmutableSourceSnapshot,
  sourceProviderAgreement,
  sourceSnapshotHash,
} from "@/modules/ai/source-provenance";

const source = {
  url: "https://example.invalid/researcher",
  title: "Fictional public profile",
  snippet: "A fictional profile used for tests.",
  publicationDate: "2026-01-02T00:00:00.000Z",
  retrievalHash: "",
  provider: "BRAVE",
  model: "web-v1",
};

describe("immutable AI web source provenance", () => {
  it("hashes the captured material deterministically", () => {
    const retrievalHash = sourceSnapshotHash(source);
    expect(retrievalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceSnapshotHash({ ...source, retrievalHash })).toBe(
      retrievalHash,
    );
  });

  it("rejects edits to source material or a mismatched hash", () => {
    const retrievalHash = sourceSnapshotHash(source);
    const stored = { ...source, retrievalHash };
    expect(() =>
      assertImmutableSourceSnapshot(stored, {
        ...stored,
        snippet: "changed after review",
      }),
    ).toThrow(/immutable/);
    expect(() =>
      assertImmutableSourceSnapshot(stored, {
        ...stored,
        retrievalHash: "0".repeat(64),
      }),
    ).toThrow(/hash/);
  });

  it("does not accept a source recorded under another provider/model", () => {
    expect(
      sourceProviderAgreement({
        runProvider: "OLLAMA",
        runModel: "qwen",
        sourceProvider: "BRAVE",
        sourceModel: "web-v1",
      }),
    ).toBe(false);
    expect(
      sourceProviderAgreement({
        runProvider: "BRAVE",
        runModel: "web-v1",
        sourceProvider: "BRAVE",
        sourceModel: "web-v1",
      }),
    ).toBe(true);
  });
});
