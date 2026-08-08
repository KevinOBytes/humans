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

function incompleteDashboardData(): never {
  throw new Error("Dashboard data is incomplete.");
}

function requiredText(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return incompleteDashboardData();
  }
  return value;
}

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
  if (!data.imports?.nodes) incompleteDashboardData();
  const imports = readFragment(
    ImportWorkspaceItemFragmentDoc,
    data.imports.nodes,
  );
  const role = context.viewer.role ?? "member";
  const normalizedRole = role.toLowerCase();

  const graphAnalyses: DashboardGraphAnalysis[] =
    data.dashboardRecentGraphAnalyses.nodes.map((analysis) => ({
      id: requiredText(analysis.id),
      algorithm: requiredText(analysis.algorithm),
      state: requiredText(analysis.state),
      createdAt: requiredText(analysis.createdAt),
      completedAt: analysis.completedAt,
    }));
  const aiAnalyses: DashboardAiAnalysis[] =
    data.dashboardRecentAiAnalyses.nodes.map((analysis) => ({
      id: requiredText(analysis.id),
      provider: requiredText(analysis.provider),
      model: requiredText(analysis.model),
      state: requiredText(analysis.state),
      createdAt: requiredText(analysis.createdAt),
      completedAt: analysis.completedAt,
    }));
  const normalizedImports: DashboardImport[] = imports.map((item) => ({
    id: requiredText(item.id),
    format: requiredText(item.format),
    state: requiredText(item.state),
    totalRows: item.totalRows,
    acceptedRows: item.acceptedRows,
    rejectedRows: item.rejectedRows,
    startedAt: requiredText(item.startedAt),
  }));
  let activity: DashboardActivity[] | null = null;
  if (includeActivity) {
    if (!data.auditEvents?.nodes) incompleteDashboardData();
    activity = data.auditEvents.nodes.map((event) => {
      if (!event.actor) incompleteDashboardData();
      return {
        action: requiredText(event.action),
        resourceKind: requiredText(event.resourceKind),
        outcome: requiredText(event.outcome),
        occurredAt: requiredText(event.occurredAt),
        actorKind: requiredText(event.actor.kind),
        actorLabel: requiredText(event.actor.label),
      };
    });
  }

  const canStartImport = [
    "file:create",
    "import:create",
    "import:run",
    "person:create",
  ].every((permission) => permissions.includes(permission));

  return (
    <DashboardOverview
      workspaceName={context.viewer.workspace.name}
      role={role}
      canCreatePerson={permissions.includes("person:create")}
      canStartImport={canStartImport}
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
