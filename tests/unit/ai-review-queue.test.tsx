import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AiReviewQueue } from "@/components/ai/ai-review-queue";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));
const suggestion = {
  id: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
  personId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
  caseId: null,
  purpose: "profile_research",
  fieldKey: "biography",
  proposedValue: { version: 1, kind: "profile", value: "Public researcher" },
  currentValue: "Original biography",
  evidenceReferences: [
    {
      kind: "evidence",
      evidenceId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
      locator: "page 1",
      quote: "Public researcher",
    },
  ],
  confidence: 0.6,
  uncertainty: "Verify identity",
  provider: "COMPATIBLE",
  model: "synthetic",
  researchRunId: "019fe224-a0cd-76e4-92ac-9d27a5c62cf5",
  promptPolicyVersion: "human-review-v1",
  status: "pending",
  version: 1,
  acceptedResourceId: null,
  acceptedResourceKind: null,
  decisionReason: null,
};
describe("AI human review queue", () => {
  it("shows current/proposed values, source, uncertainty and disclosure without auto-accepting", () => {
    execute.mockClear();
    render(
      <AiReviewQueue
        suggestions={[suggestion]}
        canReview
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Original biography")).toBeInTheDocument();
    expect(screen.getByText("Verify identity")).toBeInTheDocument();
    expect(screen.getByText(/COMPATIBLE.*synthetic/)).toBeInTheDocument();
    expect(screen.getByText(/60%/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Accept biography" }),
    ).toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
  });
  it("requires rejection reason and does not allow read-only acceptance", async () => {
    render(
      <AiReviewQueue
        suggestions={[suggestion]}
        canReview={false}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Accept biography" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reject biography" }),
    ).toBeDisabled();
  });
  it("sends an explicit single-field decision, not a person update", async () => {
    const user = userEvent.setup();
    execute.mockResolvedValue({
      ok: true,
      data: { acceptAiSuggestion: { ...suggestion, status: "accepted" } },
    });
    const changed = vi.fn();
    render(
      <AiReviewQueue suggestions={[suggestion]} canReview onChange={changed} />,
    );
    await user.click(screen.getByRole("button", { name: "Accept biography" }));
    expect(execute.mock.calls.at(-1)?.[1]).toEqual({
      input: { id: suggestion.id, expectedVersion: 1, explicitConfirmed: true },
    });
    expect(changed).toHaveBeenCalled();
  });
});
