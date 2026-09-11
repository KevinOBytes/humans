import { describe, expect, it } from "vitest";
import {
  normalizeAiSuggestion,
  normalizeAiReviewDecision,
  requireAiBatchApproval,
} from "@/modules/ai/review-validation";

const id = "019fe224-a0cd-76e4-92ac-9d27a5c62cf5";
const proposal = {
  personId: id,
  purpose: "profile_research",
  fieldKey: "biography",
  proposedValue: { version: 1, kind: "profile", value: "Public researcher" },
  confidence: 0.6,
  uncertainty: "Identity match requires human verification.",
  evidenceReferences: [
    {
      kind: "evidence",
      evidenceId: id,
      locator: "page 1",
      quote: "Public researcher",
    },
  ],
  provider: "COMPATIBLE",
  model: "synthetic",
  researchRunId: id,
  runKind: "analysis",
  promptPolicyVersion: "human-review-v1",
};
describe("AI suggestion review validation", () => {
  it("preserves one typed field and its provenance", () => {
    expect(normalizeAiSuggestion(proposal)).toMatchObject({
      fieldKey: "biography",
      confidence: 0.6,
      proposedValue: {
        version: 1,
        kind: "profile",
        value: "Public researcher",
      },
    });
  });
  it.each([
    { evidenceReferences: [] },
    { confidence: -0.1 },
    { confidence: 1.1 },
    { confidence: NaN },
    { provider: "" },
    { model: "" },
    { uncertainty: "" },
    { promptPolicyVersion: "" },
    { proposedValue: { version: 1, kind: "risk_score", value: 8 } },
    { fieldKey: "adverseDecision" },
    { proposedValue: { version: 1, kind: "profile", value: 3 } },
  ])(
    "refuses missing attribution, evidence, or unsupported values: %j",
    (override) => {
      expect(() =>
        normalizeAiSuggestion({ ...proposal, ...override }),
      ).toThrow();
    },
  );
  it("refuses relationships supported only by web URLs", () => {
    expect(() =>
      normalizeAiSuggestion({
        ...proposal,
        fieldKey: "relationship",
        proposedValue: {
          version: 1,
          kind: "relationship",
          targetPersonId: id,
          relationshipTypeId: id,
        },
        evidenceReferences: [
          {
            kind: "web",
            url: "https://example.com",
            quote: "Researcher",
            locator: "profile",
          },
        ],
      }),
    ).toThrow();
  });
  it("requires a human confirmation and a rejection reason", () => {
    expect(() =>
      normalizeAiReviewDecision({
        id,
        expectedVersion: 1,
        decision: "accepted",
        explicitConfirmed: false,
      }),
    ).toThrow();
    expect(() =>
      normalizeAiReviewDecision({
        id,
        expectedVersion: 1,
        decision: "rejected",
        reason: " ",
      }),
    ).toThrow();
    expect(
      normalizeAiReviewDecision({
        id,
        expectedVersion: 1,
        decision: "rejected",
        reason: "Wrong identity",
      }).reason,
    ).toBe("Wrong identity");
  });
  it("requires explicit batch approval and bounds unique selections", () => {
    expect(() =>
      requireAiBatchApproval({ ids: [id], approved: false }),
    ).toThrow();
    expect(() =>
      requireAiBatchApproval({ ids: [id, id], approved: true }),
    ).toThrow();
    expect(() =>
      requireAiBatchApproval({ ids: [id], approved: true }),
    ).not.toThrow();
  });
});
