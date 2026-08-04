import { getAppContext } from "@/app/(app)/app-session";
import {
  DashboardOverview,
  mergeRecentAnalyses,
  type DashboardActivity,
  type DashboardAiAnalysis,
  type DashboardGraphAnalysis,
  type DashboardImport,
} from "@/components/dashboard/dashboard-overview";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  DashboardOverviewDocument,
  ImportWorkspaceItemFragmentDoc,
  PersonSummaryFragmentDoc,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export default async function DashboardPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;

  const permissions = context.viewer.permissions;
  const includeActivity = permissions.includes("audit:read");
  const data = await executeServerGraphQL(DashboardOverviewDocument, {
    includeActivity,
  });
  const people = readFragment(
    PersonSummaryFragmentDoc,
    data.dashboardRecentPeople.nodes,
  );
  const imports = readFragment(
    ImportWorkspaceItemFragmentDoc,
    data.imports?.nodes ?? [],
  );
  const role = context.viewer.role ?? "member";
  const normalizedRole = role.toLowerCase();

  const graphAnalyses = data.dashboardRecentGraphAnalyses.nodes.flatMap(
    (analysis): DashboardGraphAnalysis[] =>
      analysis.id && analysis.createdAt
        ? [
            {
              id: analysis.id,
              algorithm: analysis.algorithm ?? "analysis",
              state: analysis.state ?? "unknown",
              createdAt: analysis.createdAt,
              completedAt: analysis.completedAt,
            },
          ]
        : [],
  );
  const aiAnalyses = data.dashboardRecentAiAnalyses.nodes.flatMap(
    (analysis): DashboardAiAnalysis[] =>
      analysis.id && analysis.createdAt
        ? [
            {
              id: analysis.id,
              provider: analysis.provider ?? "compatible",
              model: analysis.model ?? "model unavailable",
              state: analysis.state ?? "unknown",
              createdAt: analysis.createdAt,
              completedAt: analysis.completedAt,
            },
          ]
        : [],
  );
  const normalizedImports = imports.flatMap((item): DashboardImport[] =>
    item.id && item.createdAt
      ? [
          {
            id: item.id,
            format: item.format ?? "data",
            state: item.state ?? "unknown",
            totalRows: item.totalRows,
            acceptedRows: item.acceptedRows,
            rejectedRows: item.rejectedRows,
            createdAt: item.createdAt,
          },
        ]
      : [],
  );
  const activity = includeActivity
    ? (data.auditEvents?.nodes ?? []).flatMap((event): DashboardActivity[] =>
        event.action && event.occurredAt
          ? [
              {
                action: event.action,
                resourceKind: event.resourceKind ?? "workspace",
                outcome: event.outcome ?? "recorded",
                occurredAt: event.occurredAt,
                actorKind: event.actor?.kind ?? "system",
                actorLabel: event.actor?.label ?? "System",
              },
            ]
          : [],
      )
    : null;

  return (
    <DashboardOverview
      workspaceName={context.viewer.workspace.name}
      role={role}
      canCreatePerson={permissions.includes("person:create")}
      canManagePolicies={
        normalizedRole === "owner" || normalizedRole === "admin"
      }
      canReadActivity={includeActivity}
      statistics={data.graphStatistics}
      people={people.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        preferredName: person.preferredName,
        status: person.status,
        sensitivity: person.sensitivity,
        updatedAt: person.updatedAt,
      }))}
      imports={normalizedImports}
      analyses={mergeRecentAnalyses(graphAnalyses, aiAnalyses)}
      policy={data.workspacePolicySummary}
      activity={activity}
    />
  );
}
