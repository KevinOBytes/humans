import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResearchAssignmentQueue } from "@/components/cases/research-assignment-queue";
import {
  AssignResearchAssignmentDocument,
  CreateResearchAssignmentDocument,
  type ResearchAssignmentFieldsFragment,
  ResearchAssignmentsDocument,
  TransitionResearchAssignmentDocument,
} from "@/graphql/generated/graphql";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL: execute }));

const assignment: ResearchAssignmentFieldsFragment = {
  id: "018f0000-0000-7000-8000-000000000001",
  caseId: "case-a",
  queueKind: "REVIEW" as const,
  title: "Check source",
  description: null,
  priority: 4,
  status: "OPEN" as const,
  assigneePrincipalId: null,
  dueAt: null,
  escalationCount: 0,
  version: 1,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

function listResult(nodes: ResearchAssignmentFieldsFragment[] = [assignment]) {
  return {
    ok: true,
    data: {
      researchAssignments: {
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

describe("ResearchAssignmentQueue", () => {
  beforeEach(() => execute.mockReset());

  it("uses a bounded, case-scoped generated query and renders only its rows", async () => {
    execute.mockResolvedValue(listResult());
    render(<ResearchAssignmentQueue caseId="case-a" />);

    expect(await screen.findByText("Check source")).toBeVisible();
    expect(execute).toHaveBeenCalledWith(ResearchAssignmentsDocument, {
      caseId: "case-a",
      first: 25,
      status: undefined,
      queueKind: undefined,
    });
  });

  it("creates a case-linked queue item through the generated mutation", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce(listResult([]))
      .mockResolvedValueOnce({
        ok: true,
        data: { createResearchAssignment: { assignment } },
      })
      .mockResolvedValueOnce(listResult([assignment]));
    render(<ResearchAssignmentQueue caseId="case-a" />);
    await screen.findByText("No assignments are visible for this case.");
    await user.type(screen.getByLabelText("Assignment title"), "Check source");
    await user.click(screen.getByRole("button", { name: "Create assignment" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        CreateResearchAssignmentDocument,
        expect.objectContaining({
          input: expect.objectContaining({
            caseId: "case-a",
            queueKind: "REVIEW",
            title: "Check source",
            idempotencyKey: expect.any(String),
          }),
        }),
      ),
    );
  });

  it("offers only server-valid next states and sends the optimistic version", async () => {
    const user = userEvent.setup();
    execute
      .mockResolvedValueOnce(listResult())
      .mockResolvedValueOnce({
        ok: true,
        data: { transitionResearchAssignment: { assignment } },
      })
      .mockResolvedValueOnce(listResult());
    render(<ResearchAssignmentQueue caseId="case-a" />);
    await screen.findByText("Check source");
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
    await user.type(
      screen.getByLabelText("Reason for Check source"),
      "Begin review",
    );
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        TransitionResearchAssignmentDocument,
        expect.objectContaining({
          input: expect.objectContaining({
            id: assignment.id,
            expectedVersion: 1,
            status: "IN_PROGRESS",
            reason: "Begin review",
            idempotencyKey: expect.any(String),
          }),
        }),
      ),
    );
  });

  it("ignores a stale response when the selected case changes", async () => {
    let resolveFirst!: (value: ReturnType<typeof listResult>) => void;
    const first = new Promise<ReturnType<typeof listResult>>((resolve) => {
      resolveFirst = resolve;
    });
    execute
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(
        listResult([{ ...assignment, caseId: "case-b", title: "Case B work" }]),
      );
    const view = render(<ResearchAssignmentQueue caseId="case-a" />);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    view.rerender(<ResearchAssignmentQueue caseId="case-b" />);
    expect(await screen.findByText("Case B work")).toBeVisible();
    resolveFirst(listResult([assignment]));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(screen.queryByText("Check source")).toBeNull();
  });

  it("keeps the current assignee when saving without editing the field", async () => {
    const user = userEvent.setup();
    const assigned = {
      ...assignment,
      assigneePrincipalId: "018f0000-0000-7000-8000-000000000099",
    };
    execute
      .mockResolvedValueOnce(listResult([assigned]))
      .mockResolvedValueOnce({
        ok: true,
        data: { assignResearchAssignment: { assignment: assigned } },
      })
      .mockResolvedValueOnce(listResult([assigned]));
    render(<ResearchAssignmentQueue caseId="case-a" />);
    expect(await screen.findByText(/Current assignee:/)).toHaveTextContent(
      assigned.assigneePrincipalId!,
    );
    const input = screen.getByLabelText(
      "Assignee principal ID (clear to unassign)",
    );
    expect(input).toHaveValue(assigned.assigneePrincipalId);
    await user.type(
      screen.getByLabelText("Reason for Check source"),
      "Reconfirm",
    );
    await user.click(screen.getByRole("button", { name: "Save assignee" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        AssignResearchAssignmentDocument,
        expect.objectContaining({
          input: expect.objectContaining({
            assigneePrincipalId: assigned.assigneePrincipalId,
          }),
        }),
      ),
    );
  });
});
