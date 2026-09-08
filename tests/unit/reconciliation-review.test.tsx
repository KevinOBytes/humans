import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeBrowser = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => executeBrowser(...args),
}));

import { ReconciliationReview } from "@/components/people/reconciliation-review";
import { ReviewIdentityCandidateDocument } from "@/graphql/generated/graphql";

const candidate = {
  id: "018f0000-0000-7000-8000-000000000001",
  firstPersonId: "018f0000-0000-7000-8000-000000000002",
  secondPersonId: "018f0000-0000-7000-8000-000000000003",
  firstPerson: {
    id: "018f0000-0000-7000-8000-000000000002",
    displayName: "Ada Lovelace",
    preferredName: "Ada",
  },
  secondPerson: {
    id: "018f0000-0000-7000-8000-000000000003",
    displayName: "Augusta King",
    preferredName: null,
  },
  score: 0.92,
  matchSignals: { sharedEmail: true, sharedBirthDate: false },
  state: "PENDING" as const,
  reviewReason: null,
  reviewedAt: null,
  version: 4,
};

describe("ReconciliationReview", () => {
  beforeEach(() => executeBrowser.mockReset());

  it("renders names and saves a versioned review decision", async () => {
    const user = userEvent.setup();
    executeBrowser.mockResolvedValueOnce({
      ok: true,
      data: {
        reviewIdentityCandidate: {
          ...candidate,
          state: "REJECTED",
          reviewReason: "Distinct people",
          reviewedAt: "2026-09-08T14:00:00.000Z",
          version: 5,
        },
      },
      requestId: "request-review",
    });

    render(<ReconciliationReview candidates={[candidate]} canReview />);

    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      `/people/${candidate.firstPersonId}`,
    );
    expect(screen.getByText("sharedEmail: yes")).toBeVisible();
    expect(screen.getByText("92% match")).toBeVisible();

    await user.selectOptions(
      screen.getByLabelText("Review decision"),
      "REJECTED",
    );
    await user.type(screen.getByLabelText(/Reason/), "Distinct people");
    await user.click(screen.getByRole("button", { name: "Save review" }));

    await waitFor(() =>
      expect(executeBrowser).toHaveBeenCalledWith(
        ReviewIdentityCandidateDocument,
        expect.objectContaining({
          input: expect.objectContaining({
            id: candidate.id,
            expectedVersion: 4,
            state: "REJECTED",
            reason: "Distinct people",
          }),
        }),
      ),
    );
    expect(await screen.findByText("rejected")).toBeVisible();
  });

  it("does not offer mutations to viewers and reports failed reviews", async () => {
    const user = userEvent.setup();
    render(<ReconciliationReview candidates={[candidate]} canReview={false} />);
    expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled();
    expect(screen.getByLabelText("Review decision")).toBeDisabled();

    render(<ReconciliationReview candidates={[candidate]} canReview />);
    executeBrowser.mockRejectedValueOnce(new Error("unavailable"));
    await user.click(
      screen.getAllByRole("button", { name: "Save review" })[1]!,
    );
    expect(
      await screen.findByText("The reconciliation review could not be saved."),
    ).toBeVisible();
  });
});
