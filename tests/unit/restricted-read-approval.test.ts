import { describe, expect, it } from "vitest";
import { matchesRestrictedReadApproval } from "@/modules/governance/restricted-read";

const at = new Date("2026-09-11T00:00:00Z");
const binding = {
  workspaceId: "workspace",
  principalId: "principal",
  personId: "person",
  fieldDefinitionId: "field",
  purpose: "research",
  caseReference: "case-1",
  at,
};
const approval = {
  ...binding,
  id: "approval",
  scope: "restricted_read",
  state: "approved",
  reviewedAt: new Date(at.getTime() - 1000),
  deletedAt: null,
  expiresAt: new Date(at.getTime() + 1000),
};
describe("principal-bound restricted read approvals", () => {
  it("accepts an approved, reviewed, unexpired exact binding", () => {
    expect(matchesRestrictedReadApproval(approval, binding)).toBe(true);
  });
  it.each([
    { workspaceId: "other" },
    { principalId: "other" },
    { personId: "other" },
    { fieldDefinitionId: "other" },
    { purpose: "other" },
    { caseReference: null },
    { scope: "read" },
    { state: "requested" },
    { state: "revoked" },
    { reviewedAt: null },
    { deletedAt: at },
    { expiresAt: at },
    { expiresAt: null },
  ])(
    "does not authorize with mismatched or ineffective approval %j",
    (change) => {
      expect(
        matchesRestrictedReadApproval({ ...approval, ...change }, binding),
      ).toBe(false);
    },
  );
});
