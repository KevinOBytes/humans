import type { ReactElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { parse, visit } from "graphql";
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
  canStartImport: true,
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
      startedAt: "2026-08-04T14:00:00.000Z",
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

function emptyDashboardResponse(includeActivity = false) {
  return {
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
    ...(includeActivity ? { auditEvents: { nodes: [] } } : {}),
  };
}

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
        canStartImport={false}
        canManagePolicies={false}
        canReadActivity={false}
        imports={[]}
        activity={null}
      />,
    );

    expect(screen.queryByRole("link", { name: "Add person" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage policies" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View audit log" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Start an import" })).toBeNull();
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
    expect(
      screen.getByRole("link", { name: "Start an import" }),
    ).toHaveAttribute("href", "/imports");
  });

  it("wraps long workspace, analysis, and activity actor values inside cards", () => {
    const longWorkspace = "workspace".repeat(30);
    const longAnalysis = "provider-model".repeat(30);
    const longActor = "actor".repeat(40);
    render(
      <DashboardOverview
        {...baseProps}
        workspaceName={longWorkspace}
        analyses={[
          {
            id: "long-analysis",
            kind: "AI",
            label: longAnalysis,
            state: "RUNNING",
            createdAt: "2026-08-04T17:00:00.000Z",
            completedAt: null,
          },
        ]}
        activity={[
          {
            ...baseProps.activity![0]!,
            actorLabel: longActor,
          },
        ]}
      />,
    );

    expect(screen.getByText(longWorkspace)).toHaveClass(
      "break-words",
      "[overflow-wrap:anywhere]",
    );
    expect(screen.getByText(longAnalysis)).toHaveClass(
      "break-words",
      "[overflow-wrap:anywhere]",
    );
    expect(
      screen.getByText(
        (content, element) =>
          element?.tagName === "P" && content.startsWith(longActor),
      ),
    ).toHaveClass("break-words", "[overflow-wrap:anywhere]");
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
      pageMocks.executeServerGraphQL.mockResolvedValue(
        emptyDashboardResponse(expected),
      );

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

  it("requires the complete import wizard permission set", async () => {
    pageMocks.getAppContext.mockResolvedValue({
      viewer: {
        role: "contributor",
        permissions: [
          "file:create",
          "import:create",
          "import:run",
          "person:create",
        ],
        workspace: { name: "Field Research" },
      },
    });
    pageMocks.executeServerGraphQL.mockResolvedValue(emptyDashboardResponse());

    const allowed =
      (await DashboardPage()) as ReactElement<DashboardOverviewProps>;
    expect(allowed.props.canStartImport).toBe(true);

    pageMocks.getAppContext.mockResolvedValue({
      viewer: {
        role: "contributor",
        permissions: ["file:create", "import:create", "person:create"],
        workspace: { name: "Field Research" },
      },
    });
    const denied =
      (await DashboardPage()) as ReactElement<DashboardOverviewProps>;
    expect(denied.props.canStartImport).toBe(false);
  });

  it.each([
    {
      label: "an import without a format",
      response: () => ({
        ...emptyDashboardResponse(),
        imports: {
          nodes: [
            {
              id: "import-1",
              format: null,
              state: "COMPLETED",
              startedAt: "2026-08-04T10:00:00.000Z",
            },
          ],
        },
      }),
    },
    {
      label: "an AI analysis without a model",
      response: () => ({
        ...emptyDashboardResponse(),
        dashboardRecentAiAnalyses: {
          nodes: [
            {
              id: "ai-1",
              provider: "OPENAI",
              model: null,
              state: "COMPLETED",
              createdAt: "2026-08-04T10:00:00.000Z",
              completedAt: null,
            },
          ],
        },
      }),
    },
    {
      label: "a graph analysis without a state",
      response: () => ({
        ...emptyDashboardResponse(),
        dashboardRecentGraphAnalyses: {
          nodes: [
            {
              id: "graph-1",
              algorithm: "PAGERANK",
              state: null,
              createdAt: "2026-08-04T10:00:00.000Z",
              completedAt: null,
            },
          ],
        },
      }),
    },
    {
      label: "an audit event without an actor",
      audit: true,
      response: () => ({
        ...emptyDashboardResponse(true),
        auditEvents: {
          nodes: [
            {
              action: "person.updated",
              resourceKind: "person",
              outcome: "SUCCESS",
              occurredAt: "2026-08-04T10:00:00.000Z",
              actor: null,
            },
          ],
        },
      }),
    },
  ])(
    "rejects malformed dashboard data: $label",
    async ({ response, audit }) => {
      pageMocks.getAppContext.mockResolvedValue({
        viewer: {
          role: audit ? "owner" : "viewer",
          permissions: audit ? ["audit:read"] : [],
          workspace: { name: "Field Research" },
        },
      });
      pageMocks.executeServerGraphQL.mockResolvedValue(response());

      await expect(DashboardPage()).rejects.toThrow(
        "Dashboard data is incomplete.",
      );
    },
  );

  it("keeps the generated dashboard selection free of restricted analysis and audit data", () => {
    const operation = DashboardOverviewDocument.toString();
    expect(operation).toContain("@include(if: $includeActivity)");
    const fieldNames = new Set<string>();
    visit(parse(operation), {
      Field(node) {
        fieldNames.add(node.name.value);
      },
    });
    expect([...fieldNames]).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /(?:prompt|answer|error|tool|citation|diff|credential|secret|objectKey|storage(?!Enabled)|bucket)/iu,
        ),
      ]),
    );
  });
});
