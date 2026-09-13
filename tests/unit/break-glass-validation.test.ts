import { describe, expect, it } from "vitest";

import {
  normalizeBreakGlassRequest,
  normalizeBreakGlassResources,
} from "@/modules/governance/break-glass-validation";

describe("break-glass request validation", () => {
  it("normalizes a bounded purpose, justification, expiry, and case reference", () => {
    const result = normalizeBreakGlassRequest({
      purpose: "  urgent subject access  ",
      justification:
        " A documented incident requires a time-limited review of two records. ",
      expiresAt: "2026-09-14T12:00:00Z",
      caseReference: "  CASE-42  ",
    });

    expect(result).toEqual({
      purpose: "urgent subject access",
      justification:
        "A documented incident requires a time-limited review of two records.",
      expiresAt: new Date("2026-09-14T12:00:00Z"),
      caseReference: "CASE-42",
    });
  });

  it("rejects an expiry in the past and short or control-character justification", () => {
    expect(() =>
      normalizeBreakGlassRequest({
        purpose: "review",
        justification: "too short",
        expiresAt: "2020-01-01T00:00:00Z",
      }),
    ).toThrow("invalid");
    expect(() =>
      normalizeBreakGlassRequest({
        purpose: "review",
        justification: "A".repeat(30) + "\u0000",
        expiresAt: "2026-09-14T12:00:00Z",
      }),
    ).toThrow("invalid");
  });

  it("deduplicates and bounds explicit workspace resources", () => {
    expect(
      normalizeBreakGlassResources([
        {
          resourceKind: "fact",
          resourceId: "11111111-1111-4111-8111-111111111111",
        },
        {
          resourceKind: "fact",
          resourceId: "11111111-1111-4111-8111-111111111111",
        },
        {
          resourceKind: "person",
          resourceId: "22222222-2222-4222-8222-222222222222",
        },
      ]),
    ).toEqual([
      {
        resourceKind: "fact",
        resourceId: "11111111-1111-4111-8111-111111111111",
      },
      {
        resourceKind: "person",
        resourceId: "22222222-2222-4222-8222-222222222222",
      },
    ]);
  });

  it("rejects unsupported resource kinds and an empty list", () => {
    expect(() => normalizeBreakGlassResources([])).toThrow("resource");
    expect(() =>
      normalizeBreakGlassResources([
        {
          resourceKind: "workspace",
          resourceId: "11111111-1111-4111-8111-111111111111",
        },
      ]),
    ).toThrow("resource");
  });
});
