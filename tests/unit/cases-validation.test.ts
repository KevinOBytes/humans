import { describe, expect, it } from "vitest";
import {
  normalizeCaseInput,
  canReadCase,
  normalizeRelationshipProvenance,
} from "@/modules/cases/validation";

describe("case boundaries", () => {
  it("requires an explicit bounded purpose", () => {
    expect(() =>
      normalizeCaseInput({ title: "Research", purpose: " " }),
    ).toThrow();
    expect(
      normalizeCaseInput({ title: " Research ", purpose: " research " }),
    ).toEqual({ title: "Research", purpose: "research" });
  });
  it("intersects workspace, membership and resource visibility", () => {
    expect(
      canReadCase({ sameWorkspace: true, member: true, resourceVisible: true }),
    ).toBe(true);
    for (const key of ["sameWorkspace", "member", "resourceVisible"] as const) {
      expect(
        canReadCase({
          sameWorkspace: true,
          member: true,
          resourceVisible: true,
          [key]: false,
        }),
      ).toBe(false);
    }
  });
  it("rejects backwards intervals and invalid observations", () => {
    expect(() =>
      normalizeRelationshipProvenance({
        validFrom: "2026-09-02",
        validUntil: "2026-09-01",
      }),
    ).toThrow();
    expect(() =>
      normalizeRelationshipProvenance({ observedAt: "bad" }),
    ).toThrow();
  });
  it("does not allow machine-created claims to start as documented", () => {
    expect(() =>
      normalizeRelationshipProvenance({
        creationMethod: "ai",
        state: "asserted",
      }),
    ).toThrow();
    expect(
      normalizeRelationshipProvenance({
        creationMethod: "ai",
        state: "inferred",
      }).reviewState,
    ).toBe("unreviewed");
  });
});
