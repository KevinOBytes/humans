import { describe, expect, it } from "vitest";
import { evaluateAiRetention } from "@/modules/ai/retention";

const now = new Date("2026-09-11T00:00:00.000Z");
const expired = new Date("2026-08-01T00:00:00.000Z");

describe("AI artifact retention candidates", () => {
  it("returns deterministic candidates while fencing accepted suggestions and holds", () => {
    const result = evaluateAiRetention({
      now,
      retentionDays: 30,
      runs: [
        { id: "run-expired", createdAt: expired, hasAcceptedSuggestion: false },
        { id: "run-accepted", createdAt: expired, hasAcceptedSuggestion: true },
        { id: "run-current", createdAt: now, hasAcceptedSuggestion: false },
      ],
      suggestions: [
        { id: "suggestion-expired", runId: "run-expired", status: "pending" },
        {
          id: "suggestion-accepted",
          runId: "run-accepted",
          status: "accepted",
        },
      ],
      citations: [{ id: "citation-expired", runId: "run-expired" }],
      ephemeralInputs: [
        { id: "input-expired", runId: "run-expired", expiresAt: expired },
      ],
      legalHoldResourceIds: new Set(["run-expired"]),
    });
    expect(result).toEqual({
      runs: [],
      suggestions: [],
      citations: [],
      ephemeralInputs: [],
    });
  });

  it("purges expired runs only when no accepted provenance or legal hold remains", () => {
    expect(
      evaluateAiRetention({
        now,
        retentionDays: 30,
        runs: [
          {
            id: "run-expired",
            createdAt: expired,
            hasAcceptedSuggestion: false,
          },
        ],
        suggestions: [],
        citations: [],
        ephemeralInputs: [],
        legalHoldResourceIds: new Set(),
      }).runs,
    ).toEqual(["run-expired"]);
  });
});
