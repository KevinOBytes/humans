import { describe, expect, it } from "vitest";
import {
  normalizeEvidenceAssertion,
  requireReviewedPromotion,
} from "@/modules/evidence/assertions-validation";

describe("evidence assertions", () => {
  it("normalizes quotes and rejects oversized locators and unsupported resources", () => {
    const input = {
      resourceKind: "person",
      locator: " p. 2 ",
      quote: " quote ",
      role: "supports",
      confidence: 0.8,
    };
    expect(normalizeEvidenceAssertion(input).quote).toBe("quote");
    expect(() =>
      normalizeEvidenceAssertion({ ...input, locator: "x".repeat(2049) }),
    ).toThrow();
    expect(() =>
      normalizeEvidenceAssertion({ ...input, quote: "x".repeat(8001) }),
    ).toThrow();
    expect(() =>
      normalizeEvidenceAssertion({ ...input, resourceKind: "sql" }),
    ).toThrow();
    expect(() =>
      normalizeEvidenceAssertion({ ...input, confidence: 1.1 }),
    ).toThrow();
  });
  it("requires reviewer permission, assertion and approval for promotion", () => {
    const input = {
      from: "inferred",
      to: "asserted",
      reviewer: true,
      assertionApproved: true,
      approvalRecorded: true,
    };
    expect(() => requireReviewedPromotion(input)).not.toThrow();
    for (const key of [
      "reviewer",
      "assertionApproved",
      "approvalRecorded",
    ] as const) {
      expect(() =>
        requireReviewedPromotion({ ...input, [key]: false }),
      ).toThrow();
    }
    expect(() =>
      requireReviewedPromotion({
        ...input,
        to: "corroborated",
        reviewer: false,
      }),
    ).toThrow();
  });
});
