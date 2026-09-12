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
      aiRunIds: [],
      aiCitationIds: [],
      aiEphemeralInputIds: [],
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
      aiRunIds: [],
      aiCitationIds: [],
      aiEphemeralInputIds: [],
      aiSuggestionIds: ["pending"],
      webRunIds: [],
      webSourceIds: [],
      blocked: false,
    });
  });

  it("plans direct AI-run children so a held child blocks the whole deletion", () => {
    expect(
      planPersonArtifactDeletion({
        artifacts: [
          { id: "run-1", kind: "ai_run" },
          { id: "input-1", kind: "ai_ephemeral_input" },
          { id: "citation-1", kind: "ai_citation" },
        ],
        heldIds: new Set(["citation-1"]),
      }),
    ).toEqual({
      aiRunIds: ["run-1"],
      aiCitationIds: [],
      aiEphemeralInputIds: ["input-1"],
      aiSuggestionIds: [],
      webRunIds: [],
      webSourceIds: [],
      blocked: true,
    });
  });
});
