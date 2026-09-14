// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createExecutionManifest,
  executionContractsMatch,
} from "@/modules/privacy/execution-manifest";

describe("value-free privacy execution manifests", () => {
  const input = {
    secret: "ab".repeat(32),
    workspaceId: "01900000-0000-7000-8000-000000000001",
    requestId: "01900000-0000-7000-8000-000000000002",
    scope: { personIds: ["01900000-0000-7000-8000-000000000003"], fileIds: [] },
  };
  it("retains only kind counts and keyed hashes, with domain-separated identities", () => {
    const manifest = createExecutionManifest(input);
    expect(Object.keys(manifest)).toEqual(["person"]);
    expect(Object.keys(manifest.person!)).toEqual(["count", "identityHashes"]);
    expect(manifest.person).toEqual({
      count: 1,
      identityHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect(JSON.stringify(manifest)).not.toContain(input.scope.personIds[0]);
    expect(
      createExecutionManifest({ ...input, workspaceId: input.requestId }),
    ).not.toEqual(manifest);
    expect(
      createExecutionManifest({ ...input, requestId: input.workspaceId }),
    ).not.toEqual(manifest);
    expect(
      createExecutionManifest({ ...input, secret: "cd".repeat(32) }),
    ).not.toEqual(manifest);
    expect(
      createExecutionManifest({
        ...input,
        scope: { fileIds: input.scope.personIds, personIds: [] },
      }).file!.identityHashes,
    ).not.toEqual(manifest.person!.identityHashes);
  });
  it("deduplicates identities and rejects values masquerading as identifiers", () => {
    expect(
      createExecutionManifest({
        ...input,
        scope: {
          personIds: [...input.scope.personIds, ...input.scope.personIds],
          fileIds: [],
        },
      }),
    ).toEqual(createExecutionManifest(input));
    expect(() =>
      createExecutionManifest({
        ...input,
        scope: { personIds: ["Private name or email"], fileIds: [] },
      }),
    ).toThrow();
    expect(() => createExecutionManifest({ ...input, secret: "" })).toThrow();
  });
  it("rejects malformed, foreign, extra-field, action and processor-capability drift", () => {
    const contract = {
      version: 1 as const,
      action: "soft_delete" as const,
      binding: "a".repeat(64),
      policies: [
        { id: "governed-soft-delete", version: 1, hash: "b".repeat(64) },
      ],
      policyHash: "c".repeat(64),
      legalBasisDigest: "d".repeat(64),
      processorCapabilityVersion: 1 as const,
      requiredProcessors: [
        "files",
        "search",
        "cache",
        "email",
        "ai_provider",
      ] as ("files" | "search" | "cache" | "email" | "ai_provider")[],
    };
    expect(executionContractsMatch(contract, contract)).toBe(true);
    for (const changed of [
      null,
      {},
      { ...contract, binding: "f".repeat(64) },
      { ...contract, policyHash: "f".repeat(64) },
      { ...contract, legalBasisDigest: "f".repeat(64) },
      { ...contract, action: "hard_delete" },
      { ...contract, processorCapabilityVersion: 2 },
      { ...contract, requiredProcessors: ["files"] },
      { ...contract, rawValue: "private" },
    ])
      expect(executionContractsMatch(changed, contract)).toBe(false);
  });
});
