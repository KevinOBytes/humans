import { describe, expect, it } from "vitest";

import {
  effectiveGovernanceSensitivity,
  approvalTransitionSource,
  normalizeConsentRecordInput,
} from "@/modules/governance/validation";

describe("governance enforcement boundaries", () => {
  it("retains the more sensitive value during a downgrade and rejects unknown sensitivity", () => {
    expect(effectiveGovernanceSensitivity("restricted", "public")).toBe(
      "restricted",
    );
    expect(effectiveGovernanceSensitivity("internal", "confidential")).toBe(
      "confidential",
    );
    expect(() =>
      effectiveGovernanceSensitivity("internal", "secret"),
    ).toThrow();
  });

  it("allows only requested reviews and approved revocations", () => {
    expect(approvalTransitionSource("approved")).toBe("requested");
    expect(approvalTransitionSource("rejected")).toBe("requested");
    expect(approvalTransitionSource("revoked")).toBe("approved");
    expect(() => approvalTransitionSource("requested")).toThrow();
    expect(() => approvalTransitionSource("expired")).toThrow();
  });

  const consent = {
    purpose: "  Investigative   Research ",
    source: " recorded ",
    status: "granted",
    lawfulBasis: "consent",
    effectiveFrom: new Date("2026-09-11T00:00:00Z"),
    scopes: [
      {
        scope: "write",
        fieldDefinitionId: "019f4df3-a656-7002-9979-8946810c5bde",
        caseReference: " case-1 ",
      },
    ],
  };

  it("normalizes and deduplicates complete scopes without widening their constraints", () => {
    const result = normalizeConsentRecordInput({
      ...consent,
      scopes: [
        ...consent.scopes,
        { ...consent.scopes[0], caseReference: "case-1" },
      ],
    });
    expect(result.value).toMatchObject({
      purpose: "investigative research",
      source: "recorded",
      scopes: [
        {
          scope: "write",
          fieldDefinitionId: "019f4df3-a656-7002-9979-8946810c5bde",
          caseReference: "case-1",
        },
      ],
    });
    expect(result.value?.scopes).toHaveLength(1);
  });

  it.each([
    { purpose: "bad\u0000" },
    { source: "bad\u0000" },
    { noticeVersion: "x".repeat(513) },
    { collectionMethod: "bad\u0000" },
    { scopes: [{ scope: "write", caseReference: "bad\u0000" }] },
    { scopes: [{ scope: "write", fieldDefinitionId: "not-a-uuid" }] },
    { lawfulBasis: null },
    { effectiveUntil: new Date("2026-09-10T00:00:00Z") },
  ])("rejects malformed governed consent %j", (change) => {
    expect(
      normalizeConsentRecordInput({ ...consent, ...change }).issues.length,
    ).toBeGreaterThan(0);
  });

  it("retains legacy unscoped consent without manufacturing a lawful basis", () => {
    expect(
      normalizeConsentRecordInput({ ...consent, scopes: [], lawfulBasis: null })
        .value,
    ).toMatchObject({ scopes: [], lawfulBasis: null });
  });
});
