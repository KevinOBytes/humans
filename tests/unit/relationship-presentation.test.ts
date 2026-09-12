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
    ).toEqual({
      claimLabel: "Hypothesis",
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
      confidenceLabel: "Confidence 100%",
      originLabel: "Manual",
      reviewLabel: "Unreviewed",
      temporalLabel: "2000",
    });
  });

  it("uses documented only for an approved review and formats open-ended UTC dates", () => {
    expect(
      relationshipSemanticPresentation({
        confidence: 0.9,
        creationMethod: "ai",
        reviewState: "approved",
        state: "corroborated",
        temporalPrecision: "DAY",
        temporalSemantics: "BEFORE",
        validFrom: null,
        validUntil: "2020-01-01T00:30:00.000+10:00",
      }),
    ).toEqual({
      claimLabel: "Documented",
      confidenceLabel: "Confidence 90%",
      originLabel: "AI-assisted",
      reviewLabel: "Approved",
      temporalLabel: "Before Dec 31, 2019",
    });
  });
});
