import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appContext = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/app-session", () => ({ getAppContext: appContext }));
vi.mock("@/graphql/server-client", () => ({ executeServerGraphQL: execute }));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));

import EvidencePage from "@/app/(app)/evidence/page";

describe("evidence page", () => {
  beforeEach(() => {
    appContext.mockReset();
    execute.mockReset();
  });

  it("does not request owned upload sessions for a file-read-only viewer", async () => {
    appContext.mockResolvedValue({
      viewer: {
        permissions: ["file:read", "workspace:read"],
        workspace: { id: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7200" },
      },
    });
    execute.mockImplementationOnce(() =>
      Promise.resolve({
        files: {
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      }),
    );
    execute.mockImplementationOnce(() =>
      Promise.resolve({ pendingExportApprovals: [] }),
    );

    render(await EvidencePage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", { name: "Workspace files" }),
    ).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Pending uploads")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Pending export approvals" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Export query")).toBeNull();
  });

  it("renders the discoverable pending approval queue from the generated query without exported values", async () => {
    const previewHash = "a1".repeat(32);
    appContext.mockResolvedValue({
      viewer: {
        permissions: ["file:read", "workspace:read"],
        workspace: { id: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7200" },
      },
    });
    execute
      .mockResolvedValueOnce({
        files: {
          nodes: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      })
      .mockResolvedValueOnce({
        pendingExportApprovals: [
          {
            id: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7201",
            workspaceId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7200",
            purpose: "evidence release",
            caseId: null,
            previewHash,
            redactionProfile: "CONFIDENTIAL",
            requestedByPrincipalId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7202",
            reviewedByPrincipalId: null,
            state: "REQUESTED",
            requestReason: "Independent review is required.",
            decisionReason: null,
            expiresAt: "2026-09-11T13:00:00.000Z",
            reviewedAt: null,
            version: 1,
            requestAuditReference: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7203",
            reviewAuditReference: null,
            createdAt: "2026-09-11T12:00:00.000Z",
            exportedValues: "PRIVATE EXPORTED VALUE",
          },
        ],
      });

    render(await EvidencePage({ searchParams: Promise.resolve({}) }));

    const queue = screen.getByRole("region", {
      name: "Pending export approvals",
    });
    expect(queue).toHaveTextContent("evidence release");
    expect(queue).toHaveTextContent(previewHash);
    expect(queue).not.toHaveTextContent("PRIVATE EXPORTED VALUE");
  });
});
