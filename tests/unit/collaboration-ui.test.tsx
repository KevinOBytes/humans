import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvestigationList } from "@/components/investigations/investigation-list";
import { TeamAdministration } from "@/components/teams/team-administration";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL: execute }));

describe("collaboration UI", () => {
  beforeEach(() => execute.mockReset());

  it("renders investigation status and links for the authorized workspace", () => {
    render(
      <InvestigationList
        investigations={{
          nodes: [
            {
              id: "018f0000-0000-7000-8000-000000000001",
              number: 7,
              slug: "network-review",
              title: "Network review",
              objective: "Understand the fictional network.",
              purpose: "demo",
              sensitivity: "internal",
              state: "active",
              leadPrincipalId: "018f0000-0000-7000-8000-000000000002",
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: null,
              closedAt: null,
              closureReason: null,
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: /Network review/ }),
    ).toHaveAttribute(
      "href",
      "/investigations/018f0000-0000-7000-8000-000000000001",
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("INV-007")).toBeInTheDocument();
  });

  it("creates a team through the browser GraphQL mutation and refreshes the list", async () => {
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: {
          teams: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          createTeam: {
            id: "018f0000-0000-7000-8000-000000000010",
            name: "Reviewers",
            description: "Evidence reviewers",
            state: "active",
            version: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          teams: {
            nodes: [
              {
                id: "018f0000-0000-7000-8000-000000000010",
                name: "Reviewers",
                description: "Evidence reviewers",
                state: "active",
                version: 1,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          teamMembers: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    const user = userEvent.setup();
    render(<TeamAdministration />);

    await screen.findByText("No teams have been created in this workspace.");
    await user.type(screen.getByLabelText("Team name"), "Reviewers");
    await user.type(
      screen.getByLabelText("Team description"),
      "Evidence reviewers",
    );
    await user.click(screen.getByRole("button", { name: "Create team" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Reviewers/ }),
      ).toBeInTheDocument(),
    );
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        name: "Reviewers",
        description: "Evidence reviewers",
        idempotencyKey: expect.any(String),
      }),
    );
  });
});
