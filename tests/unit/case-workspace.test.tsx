import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CaseWorkspace } from "@/components/cases/case-workspace";
import { CaseTimelineDocument } from "@/graphql/generated/graphql";
const execute = vi.hoisted(() => vi.fn());
vi.mock("@/graphql/client", () => ({ executeBrowserGraphQL: execute }));
it("loads only the selected authorized case and clears links when a later request fails", async () => {
  const user = userEvent.setup();
  execute
    .mockResolvedValueOnce({
      ok: true,
      data: {
        caseTimeline: {
          nodes: [
            {
              id: "link",
              resourceKind: "person",
              resourceId: "018f0000-0000-7000-8000-000000000003",
              observedAt: "2026-09-01T00:00:00Z",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })
    .mockResolvedValueOnce({
      ok: false,
      errors: [{ message: "Hidden case title" }],
    });
  render(
    <CaseWorkspace
      cases={{
        nodes: [
          {
            id: "case-a",
            title: "Fictional Archive A",
            purpose: "archive-review",
            state: "open",
            version: 1,
            createdAt: "2026-09-01T00:00:00Z",
          },
          {
            id: "case-b",
            title: "Fictional Archive B",
            purpose: "second-review",
            state: "open",
            version: 1,
            createdAt: "2026-09-01T00:00:00Z",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }}
    />,
  );
  await user.selectOptions(screen.getByLabelText("Research case"), "case-a");
  expect(
    await screen.findByRole("link", { name: /Open person/ }),
  ).toHaveAttribute("href", expect.stringContaining("/people/018f0000"));
  expect(execute).toHaveBeenCalledWith(CaseTimelineDocument, {
    caseId: "case-a",
    first: 25,
  });
  await user.selectOptions(screen.getByLabelText("Research case"), "case-b");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Case resources are unavailable",
  );
  expect(screen.queryByRole("link", { name: /Open person/ })).toBeNull();
  expect(screen.queryByText("Hidden case title")).toBeNull();
});
