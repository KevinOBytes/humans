import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeBrowserGraphQL = vi.hoisted(() => vi.fn());

vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL }));

import { BreakGlassAdministration } from "@/components/settings/break-glass-administration";
import {
  BreakGlassAccessRequestsDocument,
  ReviewBreakGlassAccessDocument,
  type BreakGlassAccessRequestsQuery,
} from "@/graphql/generated/graphql";

type BreakGlassRequest = NonNullable<
  NonNullable<
    NonNullable<
      BreakGlassAccessRequestsQuery["breakGlassAccessRequests"]
    >["nodes"]
  >[number]
>;

function request(
  overrides: Partial<BreakGlassRequest> = {},
): BreakGlassRequest {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    purpose: "Subject access review",
    justification: "Review a restricted fact under the approved case mandate.",
    caseReference: "case-42",
    state: "REQUESTED",
    requesterPrincipalId: "22222222-2222-4222-8222-222222222222",
    reviewerPrincipalId: null,
    expiresAt: "2026-09-20T12:00:00.000Z",
    reviewedAt: null,
    reviewReason: null,
    revokedAt: null,
    version: 1,
    createdAt: "2026-09-13T12:00:00.000Z",
    resources: [
      {
        resourceKind: "fact",
        resourceId: "33333333-3333-4333-8333-333333333333",
      },
    ],
    ...overrides,
  };
}

describe("BreakGlassAdministration", () => {
  beforeEach(() => {
    executeBrowserGraphQL.mockReset();
  });

  it("shows the bounded resource list and review controls for a pending request", () => {
    render(
      <BreakGlassAdministration
        initialRequests={[request()]}
        initialPageInfo={{ hasNextPage: false, endCursor: null }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Break-glass access requests" }),
    ).toBeVisible();
    expect(screen.getByText("Subject access review")).toBeVisible();
    expect(screen.getByText(/fact · 33333333/u)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Approve request" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Reject request" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Review reason")).toBeVisible();
  });

  it("does not show review controls for an already revoked request", () => {
    render(
      <BreakGlassAdministration
        initialRequests={[
          request({
            state: "REVOKED",
            revokedAt: "2026-09-14T12:00:00.000Z",
          }),
        ]}
        initialPageInfo={{ hasNextPage: false, endCursor: null }}
      />,
    );

    expect(screen.getByText("revoked")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Approve request" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject request" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Revoke approval" }),
    ).toBeNull();
  });

  it("requires a reason and refreshes the workspace-scoped list after approval", async () => {
    const user = userEvent.setup();
    const pending = request();
    executeBrowserGraphQL
      .mockResolvedValueOnce({
        ok: true,
        data: {
          reviewBreakGlassAccess: {
            id: pending.id,
            state: "APPROVED",
            version: 2,
            reviewedAt: "2026-09-13T12:05:00.000Z",
            reviewerPrincipalId: "44444444-4444-4444-8444-444444444444",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          breakGlassAccessRequests: {
            nodes: [request({ state: "APPROVED", version: 2 })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    render(
      <BreakGlassAdministration
        initialRequests={[pending]}
        initialPageInfo={{ hasNextPage: false, endCursor: null }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve request" }));
    expect(executeBrowserGraphQL).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /at least 20 characters/u,
    );

    await user.type(
      screen.getByLabelText("Review reason"),
      "Independent administrator review confirms the documented purpose.",
    );
    await user.click(screen.getByRole("button", { name: "Approve request" }));

    await waitFor(() => expect(executeBrowserGraphQL).toHaveBeenCalledTimes(2));
    expect(executeBrowserGraphQL).toHaveBeenNthCalledWith(
      1,
      ReviewBreakGlassAccessDocument,
      expect.objectContaining({
        id: pending.id,
        expectedVersion: 1,
        state: "APPROVED",
        reason:
          "Independent administrator review confirms the documented purpose.",
      }),
    );
    expect(executeBrowserGraphQL).toHaveBeenNthCalledWith(
      2,
      BreakGlassAccessRequestsDocument,
      { first: 25, after: null },
    );
  });
});
