import type { ReactElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DashboardPage from "@/app/(app)/dashboard/page";
import {
  DashboardOverview,
  mergeRecentAnalyses,
  type DashboardOverviewProps,
} from "@/components/dashboard/dashboard-overview";
import { DashboardOverviewDocument } from "@/graphql/generated/graphql";

const pageMocks = vi.hoisted(() => ({
  executeServerGraphQL: vi.fn(),
  getAppContext: vi.fn(),
}));

vi.mock("@/app/(app)/app-session", () => ({
  getAppContext: pageMocks.getAppContext,
}));
vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: pageMocks.executeServerGraphQL,
}));
vi.mock("@/graphql/generated/fragment-masking", () => ({
  useFragment: (_document: unknown, value: unknown) => value,
}));

const baseProps: DashboardOverviewProps = {
  workspaceName: "Field Research",
  role: "owner",
  canCreatePerson: true,
  canManagePolicies: true,
  canReadActivity: true,
  statistics: { visiblePeople: 12, visibleRelationships: 18 },
  people: [
    {
      id: "person-1",
      displayName: "Ada Lovelace",
      preferredName: "Ada",
      status: "ACTIVE",
      sensitivity: "INTERNAL",
      updatedAt: "2026-08-04T15:00:00.000Z",
    },
  ],
  imports: [
    {
      id: "import-1",
      format: "CSV",
      state: "COMPLETED",
      totalRows: 30,
      acceptedRows: 28,
      rejectedRows: 2,
      createdAt: "2026-08-04T14:00:00.000Z",
    },
  ],
  analyses: mergeRecentAnalyses(
    [
      {
        id: "graph-older",
        algorithm: "PAGERANK",
        state: "COMPLETED",
        createdAt: "2026-08-04T12:00:00.000Z",
        completedAt: "2026-08-04T12:02:00.000Z",
      },
      {
        id: "graph-tie-z",
        algorithm: "COMMUNITY_DETECTION",
        state: "COMPLETED",
        createdAt: "2026-08-04T16:00:00.000Z",
        completedAt: null,
      },
    ],
    [
      {
        id: "ai-newest",
        provider: "OPENAI",
        model: "gpt-5",
        state: "COMPLETED",
        createdAt: "2026-08-04T17:00:00.000Z",
        completedAt: "2026-08-04T17:01:00.000Z",
      },
      {
        id: "ai-tie-a",
        provider: "OLLAMA",
        model: "qwen3",
        state: "RUNNING",
        createdAt: "2026-08-04T16:00:00.000Z",
        completedAt: null,
      },
    ],
  ),
  policy: {
    defaultRetentionDays: 365,
    aiEnabled: true,
    storageEnabled: false,
  },
  activity: [
    {
      action: "person.updated",
      resourceKind: "person",
      outcome: "success",
      occurredAt: "2026-08-04T18:00:00.000Z",
      actorKind: "user",
      actorLabel: "Workspace owner",
    },
  ],
};

describe("DashboardOverview", () => {
  beforeEach(() => {
    pageMocks.executeServerGraphQL.mockReset();
    pageMocks.getAppContext.mockReset();
  });

  it("renders the owner research summary with semantic lists and controls", () => {
    render(<DashboardOverview {...baseProps} />);

    expect(
      screen.getByRole("heading", { name: "Research dashboard", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add person" })).toHaveAttribute(
      "href",
      "/people/new",
    );
    expect(
      screen.getByRole("link", { name: "Manage policies" }),
    ).toHaveAttribute("href", "/settings/policies");
    expect(
      screen.getByRole("link", { name: "View audit log" }),
    ).toHaveAttribute("href", "/settings/audit");

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("18")).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Recently updated people" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Recent imports" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Recent analyses" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Workspace activity" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("time").length).toBeGreaterThanOrEqual(4);

    const analyses = screen.getByRole("list", { name: "Recent analyses" });
    const analysisItems = within(analyses).getAllByRole("listitem");
    expect(analysisItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("AI"),
      expect.stringContaining("Graph"),
      expect.stringContaining("AI"),
      expect.stringContaining("Graph"),
    ]);
    expect(analysisItems[0]).toHaveTextContent("OpenAI · gpt-5");
    expect(analysisItems[1]).toHaveTextContent("Community Detection");

    const policy = screen.getByRole("region", { name: "Workspace defaults" });
    expect(within(policy).getByText("365 days")).toBeInTheDocument();
    expect(within(policy).getByText("Enabled")).toBeInTheDocument();
    expect(within(policy).getByText("Disabled")).toBeInTheDocument();
    expect(
      screen.queryByText(/prompt|answer|credential|audit diff/i),
    ).toBeNull();
  });

  it("keeps a viewer read-only and explains administrator-managed activity", () => {
    render(
      <DashboardOverview
        {...baseProps}
        role="viewer"
        canCreatePerson={false}
        canManagePolicies={false}
        canReadActivity={false}
        activity={null}
      />,
    );

    expect(screen.queryByRole("link", { name: "Add person" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage policies" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View audit log" })).toBeNull();
    expect(
      screen.getByText("Activity is managed by workspace administrators."),
    ).toBeInTheDocument();
  });

  it("provides an explicit empty state for every dashboard panel", () => {
    render(
      <DashboardOverview
        {...baseProps}
        statistics={{ visiblePeople: 0, visibleRelationships: 0 }}
        people={[]}
        imports={[]}
        analyses={[]}
        activity={[]}
      />,
    );

    expect(
      screen.getByText("No people have been added yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No imports have been started yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No analyses have been run yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No workspace activity has been recorded yet."),
    ).toBeInTheDocument();
  });

  it("uses IDs as the deterministic tie-breaker for merged analyses", () => {
    const merged = mergeRecentAnalyses(
      [
        {
          id: "z",
          algorithm: "PAGERANK",
          state: "QUEUED",
          createdAt: "2026-08-04T10:00:00.000Z",
          completedAt: null,
        },
      ],
      [
        {
          id: "a",
          provider: "OPENAI",
          model: "gpt-5",
          state: "QUEUED",
          createdAt: "2026-08-04T10:00:00.000Z",
          completedAt: null,
        },
      ],
    );

    expect(merged.map(({ id }) => id)).toEqual(["z", "a"]);
  });

  it.each([
    { permissions: ["person:read"], expected: false },
    { permissions: ["person:read", "audit:read"], expected: true },
  ])(
    "conditionally requests activity from the server when audit access is $expected",
    async ({ permissions, expected }) => {
      pageMocks.getAppContext.mockResolvedValue({
        viewer: {
          role: expected ? "owner" : "viewer",
          permissions,
          workspace: { name: "Field Research" },
        },
      });
      pageMocks.executeServerGraphQL.mockResolvedValue({
        dashboardRecentPeople: { nodes: [] },
        imports: { nodes: [] },
        dashboardRecentGraphAnalyses: { nodes: [] },
        dashboardRecentAiAnalyses: { nodes: [] },
        graphStatistics: { visiblePeople: 0, visibleRelationships: 0 },
        workspacePolicySummary: {
          defaultRetentionDays: null,
          aiEnabled: false,
          storageEnabled: false,
        },
        ...(expected ? { auditEvents: { nodes: [] } } : {}),
      });

      const result =
        (await DashboardPage()) as ReactElement<DashboardOverviewProps>;

      expect(pageMocks.executeServerGraphQL).toHaveBeenCalledOnce();
      expect(pageMocks.executeServerGraphQL).toHaveBeenCalledWith(
        DashboardOverviewDocument,
        { includeActivity: expected },
      );
      expect(result.props.canReadActivity).toBe(expected);
      expect(result.props.activity).toEqual(expected ? [] : null);
    },
  );

  it("keeps the generated dashboard selection free of restricted analysis and audit data", () => {
    const operation = DashboardOverviewDocument.toString();
    expect(operation).toContain("@include(if: $includeActivity)");
    expect(operation).not.toMatch(
      /\b(?:prompt|answer|errorCode|toolCalls|diff|objectKey|storageKey|credential)\b/u,
    );
  });
});
