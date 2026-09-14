import { describe, expect, it } from "vitest";

import {
  relationshipPresentation,
  relationshipSemanticPresentation,
} from "@/components/relationships/relationship-presentation";

const type = {
  directed: true,
  forwardLabel: "Parent of",
  inverseLabel: "Child of",
};

describe("relationshipPresentation", () => {
  it("uses forward labels from the source and inverse labels from the target", () => {
    expect(
      relationshipPresentation({
        relationship: {
          sourcePersonId: "person-a",
          targetPersonId: "person-b",
        },
        type,
        viewedPersonId: "person-a",
      }),
    ).toEqual({ counterpartId: "person-b", label: "Parent of" });
    expect(
      relationshipPresentation({
        relationship: {
          sourcePersonId: "person-a",
          targetPersonId: "person-b",
        },
        type,
        viewedPersonId: "person-b",
      }),
    ).toEqual({ counterpartId: "person-a", label: "Child of" });
  });

  it("keeps claim, origin, review, confidence, and approximate year range distinct", () => {
    expect(
      relationshipSemanticPresentation({
        confidence: 0.72,
        creationMethod: "import",
        reviewState: "unreviewed",
        state: "inferred",
        temporalPrecision: "YEAR",
        temporalSemantics: "APPROXIMATE",
        validFrom: "2012-01-01T23:00:00.000-08:00",
        validUntil: "2014-12-31T01:00:00.000+10:00",
      }),
    ).toMatchObject({
      claimLabel: "Hypothesis",
      strengthLabel: "Strength not recorded",
      evidenceLabel: "Evidence status not recorded",
      confidenceLabel: "Confidence 72%",
      originLabel: "Imported",
      reviewLabel: "Unreviewed",
      temporalLabel: "Approx. 2012–2014",
    });
  });

  it("labels unreviewed manual assertions without implying documentation", () => {
    expect(
      relationshipSemanticPresentation({
        confidence: 1,
        creationMethod: "manual",
        reviewState: "unreviewed",
        state: "asserted",
        temporalPrecision: "YEAR",
        temporalSemantics: "YEAR_ONLY",
        validFrom: "1999-12-31T23:30:00.000-08:00",
        validUntil: "2000-12-31T23:59:59.999Z",
      }),
    ).toEqual({
      claimLabel: "Manual assertion",
      strengthLabel: "Strength not recorded",
      evidenceLabel: "Evidence status not recorded",
      confidenceLabel: "Confidence 100%",
      originLabel: "Manual",
      reviewLabel: "Unreviewed",
      temporalLabel: "2000",
    });
  });

  it("keeps corroboration separate from documentation and formats open-ended UTC dates", () => {
    expect(
      relationshipSemanticPresentation({
        confidence: 0.9,
        creationMethod: "ai",
        reviewState: "approved",
        epistemicStatus: "DOCUMENTED",
        state: "corroborated",
        temporalPrecision: "DAY",
        temporalSemantics: "BEFORE",
        validFrom: null,
        validUntil: "2020-01-01T00:30:00.000+10:00",
      }),
    ).toMatchObject({
      claimLabel: "Corroborated",
      evidenceLabel: "Documented source claim",
      confidenceLabel: "Confidence 90%",
      originLabel: "AI-assisted",
      reviewLabel: "Approved",
      temporalLabel: "Before Dec 31, 2019",
    });
  });

  it.each(["approved", "unreviewed", "rejected"])(
    "does not promote an analyst hypothesis when review is %s",
    (reviewState) => {
      expect(
        relationshipSemanticPresentation({
          epistemicStatus: "ANALYST_HYPOTHESIS",
          reviewState,
          state: "asserted",
          creationMethod: "manual",
        }),
      ).toMatchObject({
        claimLabel: "Manual assertion",
        evidenceLabel: "Analyst hypothesis",
      });
    },
  );

  it("does not imply documentation for a missing or unrecognized evidence status", () => {
    for (const epistemicStatus of [undefined, null, "unexpected"]) {
      expect(
        relationshipSemanticPresentation({
          epistemicStatus,
          reviewState: "approved",
        }).evidenceLabel,
      ).toBe("Evidence status not recorded");
    }
  });

  it.each([
    [null, "Strength not recorded"],
    [0, "Strength 0%"],
    [0.7, "Strength 70%"],
    [1, "Strength 100%"],
  ])("keeps strength %s distinct from confidence", (strength, expected) => {
    expect(
      relationshipSemanticPresentation({ strength, confidence: 0.9 }),
    ).toMatchObject({
      strengthLabel: expected,
      confidenceLabel: "Confidence 90%",
    });
  });
});
