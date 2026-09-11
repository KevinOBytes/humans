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
  it("does not launder unreviewed inference through disputed status", () => {
    const review = {
      reviewState: "unreviewed",
      reviewer: false,
      assertionApproved: false,
      approvalRecorded: false,
    };
    expect(() =>
      requireReviewedPromotion({ ...review, from: "inferred", to: "disputed" }),
    ).not.toThrow();
    expect(() =>
      requireReviewedPromotion({
        ...review,
        from: "disputed",
        to: "corroborated",
      }),
    ).toThrow();
    expect(() =>
      requireReviewedPromotion({ ...review, from: "disputed", to: "asserted" }),
    ).toThrow();
  });
  it("allows disputed claims to become documented only with the complete review bundle", () => {
    const input = {
      from: "disputed",
      to: "corroborated",
      reviewState: "unreviewed",
      reviewer: true,
      assertionApproved: true,
      approvalRecorded: true,
    };
    expect(() => requireReviewedPromotion(input)).not.toThrow();
    for (const key of [
      "reviewer",
      "assertionApproved",
      "approvalRecorded",
    ] as const)
      expect(() =>
        requireReviewedPromotion({ ...input, [key]: false }),
      ).toThrow();
  });
  it("preserves ordinary edits to an unchanged documented state", () => {
    expect(() =>
      requireReviewedPromotion({
        from: "asserted",
        to: "asserted",
        reviewState: "unreviewed",
        reviewer: false,
        assertionApproved: false,
        approvalRecorded: false,
      }),
    ).not.toThrow();
  });
});
