import { describe, expect, it } from "vitest";

import { relationshipPresentation } from "@/components/relationships/relationship-presentation";

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
});
