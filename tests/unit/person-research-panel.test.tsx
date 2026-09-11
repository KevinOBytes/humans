import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import { PersonResearchPanel } from "@/components/people/person-research-panel";
import {
  PersonWebResearchDocument,
  AcceptAiSuggestionDocument,
  PendingAiSuggestionsDocument,
} from "@/graphql/generated/graphql";
const person = {
  id: "8aca7f8d-4c04-4777-94fd-bb12592b2494",
  displayName: "Ada Researcher",
  biography: "Original biography",
  version: 3,
};
const runId = "019fe224-a0cd-76e4-92ac-9d27a5c62cf5";
const suggestion = {
  id: runId,
  personId: person.id,
  caseId: null,
  purpose: "research",
  fieldKey: "biography",
  proposedValue: { version: 1, kind: "profile", value: "Public researcher" },
  currentValue: person.biography,
  evidenceReferences: [
    {
      kind: "web",
      url: "https://example.com/ada",
      locator: "Profile",
      quote: "Public profile excerpt",
    },
  ],
  confidence: 0,
  uncertainty: "Verify identity",
  provider: "COMPATIBLE",
  model: "synthetic",
  researchRunId: runId,
  promptPolicyVersion: "human-review-v1",
  status: "pending",
  version: 1,
  acceptedResourceId: null,
  acceptedResourceKind: null,
  decisionReason: null,
};
async function research(user: ReturnType<typeof userEvent.setup>) {
  execute
    .mockResolvedValueOnce({ ok: true, data: { personWebResearch: { runId } } })
    .mockResolvedValueOnce({
      ok: true,
      data: { pendingAiSuggestions: [suggestion] },
    });
  await user.type(screen.getByLabelText("Governed purpose"), "research");
  await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
  await user.click(
    screen.getByRole("button", { name: "Research this person" }),
  );
  await screen.findByText("Public researcher");
}
describe("PersonResearchPanel governed review", () => {
  beforeEach(() => {
    execute.mockReset();
    refresh.mockReset();
  });
  it("requires consent and purpose and displays persisted suggestions without applying them", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    expect(
      screen.getByRole("button", { name: "Research this person" }),
    ).toBeDisabled();
    await research(user);
    expect(execute).toHaveBeenCalledWith(PersonWebResearchDocument, {
      personId: person.id,
      consent: true,
      purpose: "research",
      caseId: null,
    });
    expect(execute).toHaveBeenCalledWith(PendingAiSuggestionsDocument, {
      personId: person.id,
      purpose: "research",
      caseId: null,
    });
    expect(screen.getByRole("status")).toHaveTextContent(runId);
    expect(screen.getByText("Original biography")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("applies a single immutable proposal through its versioned review operation", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    await research(user);
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: { acceptAiSuggestion: { ...suggestion, status: "accepted" } },
      })
      .mockResolvedValueOnce({ ok: true, data: { pendingAiSuggestions: [] } });
    await user.click(screen.getByRole("button", { name: "Accept biography" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(AcceptAiSuggestionDocument, {
      input: { id: runId, expectedVersion: 1, explicitConfirmed: true },
    });
  });
  it("keeps read-only reviewers from accepting a field", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate={false} />);
    await research(user);
    expect(
      screen.getByRole("button", { name: "Accept biography" }),
    ).toBeDisabled();
  });
  it("retains the original proposal after a failed decision", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    await research(user);
    execute.mockResolvedValueOnce({
      ok: false,
      errors: [{ message: "Conflict" }],
    });
    await user.click(screen.getByRole("button", { name: "Accept biography" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be saved",
    );
    expect(screen.getByText("Public researcher")).toBeVisible();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("recovers from a thrown provider request", async () => {
    const user = userEvent.setup();
    render(<PersonResearchPanel person={person} canUpdate />);
    execute.mockRejectedValueOnce(new Error("unavailable"));
    await user.type(screen.getByLabelText("Governed purpose"), "research");
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await user.click(
      screen.getByRole("button", { name: "Research this person" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be completed",
    );
    expect(
      screen.getByRole("button", { name: "Research this person" }),
    ).toBeEnabled();
  });
});
