import { describe, expect, it } from "vitest";

import { evaluateCoverage } from "@/modules/governance/coverage";

const current = new Date("2026-09-11T12:00:00.000Z");
const policy = {
  id: "policy-1",
  purpose: "research",
  lawfulBases: ["consent"] as const,
  caseReference: null,
};
const consent = {
  id: "consent-1",
  status: "granted" as const,
  lawfulBasis: "consent" as const,
  effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
  effectiveUntil: null,
  withdrawnAt: null,
  scopes: [{ scope: "write" as const, fieldDefinitionId: null, caseReference: null }],
};

describe("purpose coverage", () => {
  it("allows a current matching consent and policy", () => {
    expect(
      evaluateCoverage({ policy, consent, scope: "write", at: current }),
    ).toEqual({
      allowed: true,
      reason: "covered",
      consentRecordId: "consent-1",
      policyId: "policy-1",
    });
  });

  it("fails closed for expired, withdrawn, and missing scope coverage", () => {
    expect(
      evaluateCoverage({
        policy,
        consent: { ...consent, effectiveUntil: new Date("2026-09-10T00:00:00.000Z") },
        scope: "write",
        at: current,
      }).reason,
    ).toBe("expired");
    expect(
      evaluateCoverage({
        policy,
        consent: { ...consent, status: "withdrawn", withdrawnAt: current },
        scope: "write",
        at: current,
      }).reason,
    ).toBe("withdrawn");
    expect(
      evaluateCoverage({ policy, consent, scope: "export", at: current }).reason,
    ).toBe("field_not_permitted");
  });

  it("does not let a scoped consent cross a field or case boundary", () => {
    const scoped = {
      ...consent,
      scopes: [
        {
          scope: "write" as const,
          fieldDefinitionId: "field-1",
          caseReference: "case-a",
        },
      ],
    };
    expect(
      evaluateCoverage({
        policy,
        consent: scoped,
        scope: "write",
        fieldDefinitionId: "field-2",
        caseReference: "case-a",
        at: current,
      }).reason,
    ).toBe("field_not_permitted");
    expect(
      evaluateCoverage({
        policy,
        consent: scoped,
        scope: "write",
        fieldDefinitionId: "field-1",
        caseReference: "case-b",
        at: current,
      }).reason,
    ).toBe("case_not_permitted");
  });
});
