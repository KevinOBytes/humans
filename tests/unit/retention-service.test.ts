import { describe, expect, it } from "vitest";
import {
  privacyArtifactVisible,
  privacyResourceKinds,
  retentionDecision,
} from "@/modules/privacy/retention-service";
const base = {
  now: new Date("2026-09-11T00:00:00Z"),
  createdAt: new Date("2026-09-01T00:00:00Z"),
  held: false,
  policy: { id: "policy", retentionDays: 10, deletionBehavior: "soft_delete" },
};
describe("retention decisions", () => {
  it("publishes the workspace-scoped legal-hold resource vocabulary", () => {
    expect(privacyResourceKinds).toEqual([
      "person",
      "file",
      "ai_thread",
      "ai_run",
      "ai_ephemeral_input",
      "ai_suggestion",
      "ai_citation",
      "person_web_research_run",
      "person_web_research_source",
    ]);
  });
  it("requires private AI artifacts to belong to the actor and person-linked artifacts to be visible", () => {
    expect(
      privacyArtifactVisible({
        actorPrincipalId: "principal-1",
        threadOwnerId: "principal-2",
        threadSharing: "private",
        personVisible: true,
        requiresPersonVisibility: true,
      }),
    ).toBe(false);
    expect(
      privacyArtifactVisible({
        actorPrincipalId: "principal-1",
        threadOwnerId: "principal-2",
        threadSharing: "workspace",
        personVisible: false,
        requiresPersonVisibility: true,
      }),
    ).toBe(false);
    expect(
      privacyArtifactVisible({
        actorPrincipalId: "principal-1",
        threadOwnerId: "principal-1",
        threadSharing: "private",
        personVisible: true,
        requiresPersonVisibility: true,
      }),
    ).toBe(true);
  });
  it("makes an exact due-time decision without deleting anything", () => {
    expect(retentionDecision(base).state).toBe("eligible_for_deletion");
    expect(
      retentionDecision({ ...base, now: new Date("2026-09-10T23:59:59Z") })
        .state,
    ).toBe("retained");
  });
  it("legal holds take precedence over elapsed retention", () => {
    expect(retentionDecision({ ...base, held: true })).toMatchObject({
      state: "blocked_by_legal_hold",
      policyId: "policy",
    });
  });
  it("fails closed without a policy and requires review for hard deletion or anonymization", () => {
    expect(retentionDecision({ ...base, policy: null }).state).toBe(
      "review_required",
    );
    for (const deletionBehavior of ["review", "hard_delete", "anonymize"])
      expect(
        retentionDecision({
          ...base,
          policy: { ...base.policy, deletionBehavior },
        }).state,
      ).toBe("review_required");
  });
  it("rejects invalid dates and policy intervals", () => {
    expect(() =>
      retentionDecision({ ...base, createdAt: new Date("invalid") }),
    ).toThrow();
    expect(() =>
      retentionDecision({
        ...base,
        policy: { ...base.policy, retentionDays: -1 },
      }),
    ).toThrow();
  });
});
