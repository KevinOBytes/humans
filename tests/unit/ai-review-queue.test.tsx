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
  acceptedFromRunId: null,
  acceptedEvidenceReferences: null,
  decisionReason: null,
};
describe("AI human review queue", () => {
  it("retains the entire batch key after transport loss and replaces it for changed membership", async () => {
    const user = userEvent.setup();
    execute.mockReset();
    execute.mockRejectedValue(new Error("transport lost"));
    const second = {
      ...suggestion,
      id: "019fe224-a0cd-76e4-92ac-9d27a5c62cf6",
      fieldKey: "preferredName",
    };
    render(
      <AiReviewQueue
        suggestions={[suggestion, second]}
        canReview
        onChange={() => {}}
      />,
    );
    await user.click(
      screen.getByLabelText("Select biography for batch review"),
    );
    await user.click(
      screen.getByLabelText("Select preferredName for batch review"),
    );
    const approve = screen.getByLabelText(
      "I reviewed the evidence and explicitly approve the selected fields",
    );
    await user.click(approve);
    const apply = screen.getByRole("button", { name: "Apply selected fields" });
    await user.click(apply);
    await user.click(apply);
    const first = execute.mock.calls[0]![1].input;
    expect(first.idempotencyKey).toEqual(expect.any(String));
    expect(first.suggestions).toHaveLength(2);
    expect(execute.mock.calls[1]![1].input).toEqual(first);
    await user.click(
      screen.getByLabelText("Select preferredName for batch review"),
    );
    await user.click(approve);
    await user.click(apply);
    expect(execute.mock.calls[2]![1].input.idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
    expect(execute.mock.calls[2]![1].input.suggestions).toEqual([
      { id: suggestion.id, expectedVersion: 1 },
    ]);
  });
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
      input: {
        id: suggestion.id,
        expectedVersion: 1,
        explicitConfirmed: true,
        idempotencyKey: expect.any(String),
      },
    });
    expect(changed).toHaveBeenCalled();
  });
  it("retains a decision key after uncertain transport and replaces it when the reason changes", async () => {
    const user = userEvent.setup();
    execute.mockReset();
    execute.mockRejectedValue(new Error("transport lost"));
    render(
      <AiReviewQueue
        suggestions={[suggestion]}
        canReview
        onChange={() => {}}
      />,
    );
    const reason = screen.getByLabelText("Reason for rejecting biography");
    await user.type(reason, "Not supported");
    const reject = screen.getByRole("button", { name: "Reject biography" });
    await user.click(reject);
    await user.click(reject);
    const first = execute.mock.calls[0]![1].input.idempotencyKey;
    expect(first).toEqual(expect.any(String));
    expect(execute.mock.calls[1]![1].input.idempotencyKey).toBe(first);
    await user.type(reason, " by evidence");
    await user.click(reject);
    expect(execute.mock.calls[2]![1].input.idempotencyKey).not.toBe(first);
  });
});
