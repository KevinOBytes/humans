import { describe, expect, it } from "vitest";

import { planPersonArtifactDeletion } from "@/modules/privacy/artifact-retention";

describe("person-scoped artifact retention", () => {
  it("plans every descendant for subject deletion but never crosses a hold", () => {
    expect(
      planPersonArtifactDeletion({
        artifacts: [
          { id: "run-1", kind: "web_run" },
          { id: "source-1", kind: "web_source" },
          { id: "suggestion-1", kind: "ai_suggestion" },
          { id: "run-1", kind: "web_run" },
        ],
        heldIds: new Set(["suggestion-1"]),
      }),
    ).toEqual({
      aiSuggestionIds: [],
      webRunIds: ["run-1"],
      webSourceIds: ["source-1"],
      blocked: true,
    });
  });

  it("does not select accepted AI suggestions for ordinary retention", () => {
    expect(
      planPersonArtifactDeletion({
        artifacts: [
          { id: "accepted", kind: "ai_suggestion", accepted: true },
          { id: "pending", kind: "ai_suggestion", accepted: false },
        ],
        heldIds: new Set(),
        mode: "retention",
      }),
    ).toEqual({
      aiSuggestionIds: ["pending"],
      webRunIds: [],
      webSourceIds: [],
      blocked: false,
    });
  });
});
