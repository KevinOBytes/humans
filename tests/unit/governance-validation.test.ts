import { describe, expect, it } from "vitest";

import {
  normalizeGovernanceInput,
  validateApprovalReason,
} from "@/modules/governance/validation";

describe("governance validation", () => {
  it("normalizes purpose and scope values without accepting control characters", () => {
    expect(
      normalizeGovernanceInput({
        purpose: "  Investigative  Research ",
        scopes: [" AI_OPERATION ", "write", "ai_operation"],
        lawfulBasis: "CONSENT",
      }),
    ).toMatchObject({
      value: {
        purpose: "investigative research",
        scopes: ["ai_operation", "write"],
        lawfulBasis: "consent",
      },
      issues: [],
    });
    expect(
      normalizeGovernanceInput({
        purpose: "research\u0000",
        scopes: ["read"],
        lawfulBasis: "consent",
      }).issues,
    ).not.toEqual([]);
  });

  it("requires explicit lawful basis and ordered UTC effective intervals", () => {
    expect(
      normalizeGovernanceInput({
        purpose: "research",
        scopes: ["write"],
        lawfulBasis: "consent",
        effectiveFrom: "2026-09-11T00:00:00.000Z",
        effectiveUntil: "2026-09-12T00:00:00.000Z",
      }).issues,
    ).toEqual([]);
    expect(
      normalizeGovernanceInput({
        purpose: "research",
        scopes: ["write"],
        lawfulBasis: "implied",
        effectiveFrom: "2026-09-12T00:00:00.000Z",
        effectiveUntil: "2026-09-11T00:00:00.000Z",
      }).issues,
    ).not.toEqual([]);
    expect(
      normalizeGovernanceInput({
        purpose: "research",
        scopes: ["write"],
        lawfulBasis: "consent",
        effectiveFrom: "2026-09-11T00:00:00.000+01:00",
      }).issues,
    ).not.toEqual([]);
  });

  it("accepts only bounded metadata and a non-empty approval reason", () => {
    expect(
      normalizeGovernanceInput({
        purpose: "research",
        scopes: ["restricted_read"],
        lawfulBasis: "legal_obligation",
        metadata: { notice: "v2" },
      }).issues,
    ).toEqual([]);
    expect(
      normalizeGovernanceInput({
        purpose: "research",
        scopes: ["restricted_read"],
        lawfulBasis: "legal_obligation",
        metadata: { payload: "x".repeat(70_000) },
      }).issues,
    ).not.toEqual([]);
    expect(validateApprovalReason("  documented need ").value).toBe(
      "documented need",
    );
    expect(validateApprovalReason("\u0000").issues).not.toEqual([]);
  });
});
