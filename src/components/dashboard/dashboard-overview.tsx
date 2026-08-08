import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

export type DashboardPerson = {
  id: string;
  displayName: string;
  preferredName: string | null;
  status: string;
  sensitivity: string;
  updatedAt: string;
};

export type DashboardImport = {
  id: string;
  format: string;
  state: string;
  totalRows: number | null;
  acceptedRows: number | null;
  rejectedRows: number | null;
  startedAt: string;
};

export type DashboardGraphAnalysis = {
  id: string;
  algorithm: string;
  state: string;
  createdAt: string;
  completedAt: string | null;
};

export type DashboardAiAnalysis = {
  id: string;
  provider: string;
  model: string;
  state: string;
  createdAt: string;
  completedAt: string | null;
};

export type DashboardAnalysis = {
  id: string;
  kind: "AI" | "Graph";
  label: string;
  state: string;
  createdAt: string;
  completedAt: string | null;
};

export type DashboardActivity = {
  action: string;
  resourceKind: string;
  outcome: string;
  occurredAt: string;
  actorKind: string;
  actorLabel: string;
};

export type DashboardOverviewProps = {
  workspaceName: string;
  role: string;
  canCreatePerson: boolean;
  canStartImport: boolean;
  canManagePolicies: boolean;
  canReadActivity: boolean;
  statistics: {
    visiblePeople: number;
    visibleRelationships: number;
  };
  people: readonly DashboardPerson[];
  imports: readonly DashboardImport[];
  analyses: readonly DashboardAnalysis[];
  policy: {
    defaultRetentionDays: number | null;
    aiEnabled: boolean;
    storageEnabled: boolean;
  };
  activity: readonly DashboardActivity[] | null;
};

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function providerLabel(provider: string): string {
  if (provider.toUpperCase() === "OPENAI") return "OpenAI";
  return humanize(provider);
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Date unavailable"
    : dateFormatter.format(date);
}

export function mergeRecentAnalyses(
  graphAnalyses: readonly DashboardGraphAnalysis[],
  aiAnalyses: readonly DashboardAiAnalysis[],
): DashboardAnalysis[] {
  const merged: DashboardAnalysis[] = [
    ...graphAnalyses.map((analysis) => ({
      id: analysis.id,
      kind: "Graph" as const,
      label: humanize(analysis.algorithm),
      state: analysis.state,
      createdAt: analysis.createdAt,
      completedAt: analysis.completedAt,
    })),
    ...aiAnalyses.map((analysis) => ({
      id: analysis.id,
      kind: "AI" as const,
      label: `${providerLabel(analysis.provider)} · ${analysis.model}`,
      state: analysis.state,
      createdAt: analysis.createdAt,
      completedAt: analysis.completedAt,
    })),
  ];

  return merged.sort((left, right) => {
    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    return byCreatedAt || right.id.localeCompare(left.id);
  });
}

function EmptyState({ children }: { children: string }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function SectionHeader({
  id,
  title,
  href,
  linkLabel,
}: {
  id: string;
  title: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {href && linkLabel ? (
        <Link
          href={href}
          className="text-primary text-sm font-semibold underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          {linkLabel}
        </Link>
      ) : null}
    </div>
  );
}

const panelClassName =
  "border-border bg-card rounded-2xl border p-5 shadow-sm sm:p-6";

export function DashboardOverview({
  workspaceName,
  role,
  canCreatePerson,
  canStartImport,
  canManagePolicies,
  canReadActivity,
  statistics,
  people,
  imports,
  analyses,
  policy,
  activity,
}: DashboardOverviewProps) {
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-full min-w-0">
          <p className="text-primary text-sm font-semibold [overflow-wrap:anywhere] break-words">
            {workspaceName}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Research dashboard
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">
            Signed in as {humanize(role || "member")}. Review the latest visible
            workspace research.
          </p>
        </div>
        {canCreatePerson ? (
          <Link href="/people/new" className={buttonVariants()}>
            Add person
          </Link>
        ) : null}
      </header>

      <section aria-labelledby="workspace-statistics-heading">
        <h2 id="workspace-statistics-heading" className="sr-only">
          Visible workspace statistics
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className={panelClassName}>
            <dt className="text-muted-foreground text-sm">Visible people</dt>
            <dd className="mt-2 text-3xl font-semibold tabular-nums">
              {statistics.visiblePeople}
            </dd>
          </div>
          <div className={panelClassName}>
            <dt className="text-muted-foreground text-sm">
              Visible relationships
            </dt>
            <dd className="mt-2 text-3xl font-semibold tabular-nums">
              {statistics.visibleRelationships}
            </dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section
          aria-labelledby="recent-people-heading"
          className={panelClassName}
        >
          <SectionHeader
            id="recent-people-heading"
            title="Recent people"
            href="/people"
            linkLabel="View all people"
          />
          {people.length ? (
            <ul aria-label="Recently updated people" className="mt-4 divide-y">
              {people.map((person) => (
                <li key={person.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/people/${person.id}`}
                        className="font-semibold underline-offset-4 hover:underline"
                      >
                        {person.displayName}
                      </Link>
                      {person.preferredName ? (
                        <p className="text-muted-foreground mt-1 text-xs">
                          Known as {person.preferredName}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge>{humanize(person.status)}</Badge>
                      <Badge variant="neutral">
                        {humanize(person.sensitivity)}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Updated{" "}
                    <time dateTime={person.updatedAt}>
                      {displayDate(person.updatedAt)}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 space-y-3">
              <EmptyState>No people have been added yet.</EmptyState>
              {canCreatePerson ? (
                <Link
                  href="/people/new"
                  className="text-primary text-sm font-semibold underline"
                >
                  Add the first person
                </Link>
              ) : null}
            </div>
          )}
        </section>

        <section
          aria-labelledby="recent-imports-heading"
          className={panelClassName}
        >
          <SectionHeader
            id="recent-imports-heading"
            title="Recent imports"
            href="/imports"
            linkLabel="Open imports"
          />
          {imports.length ? (
            <ul aria-label="Recent imports" className="mt-4 divide-y">
              {imports.map((item) => (
                <li key={item.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">
                        {humanize(item.format)} import
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {item.acceptedRows ?? 0} accepted ·{" "}
                        {item.rejectedRows ?? 0} rejected
                        {item.totalRows == null
                          ? ""
                          : ` · ${item.totalRows} total`}
                      </p>
                    </div>
                    <Badge variant="neutral">{humanize(item.state)}</Badge>
                  </div>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Started{" "}
                    <time dateTime={item.startedAt}>
                      {displayDate(item.startedAt)}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 space-y-3">
              <EmptyState>No imports have been started yet.</EmptyState>
              {canStartImport ? (
                <Link
                  href="/imports"
                  className="text-primary text-sm font-semibold underline"
                >
                  Start an import
                </Link>
              ) : null}
            </div>
          )}
        </section>

        <section
          aria-labelledby="recent-analyses-heading"
          className={panelClassName}
        >
          <SectionHeader id="recent-analyses-heading" title="Recent analyses" />
          {analyses.length ? (
            <ul aria-label="Recent analyses" className="mt-4 divide-y">
              {analyses.map((analysis) => (
                <li
                  key={`${analysis.kind}-${analysis.id}`}
                  className="py-4 first:pt-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold [overflow-wrap:anywhere] break-words">
                        {analysis.label}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        Created{" "}
                        <time dateTime={analysis.createdAt}>
                          {displayDate(analysis.createdAt)}
                        </time>
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Badge>{analysis.kind}</Badge>
                      <Badge variant="neutral">
                        {humanize(analysis.state)}
                      </Badge>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No analyses have been run yet.</EmptyState>
          )}
          <div className="mt-4 flex flex-wrap gap-4 text-sm font-semibold">
            <Link
              href="/graph"
              className="text-primary underline-offset-4 hover:underline"
            >
              Open graph analysis
            </Link>
            <Link
              href="/analyst"
              className="text-primary underline-offset-4 hover:underline"
            >
              Open AI analyst
            </Link>
          </div>
        </section>

        <section
          aria-labelledby="workspace-defaults-heading"
          className={panelClassName}
        >
          <SectionHeader
            id="workspace-defaults-heading"
            title="Workspace defaults"
            {...(canManagePolicies
              ? {
                  href: "/settings/policies",
                  linkLabel: "Manage policies",
                }
              : {})}
          />
          <dl className="mt-4 grid gap-4 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">
                Default retention
              </dt>
              <dd className="mt-1 font-semibold">
                {policy.defaultRetentionDays == null
                  ? "Not configured"
                  : `${policy.defaultRetentionDays} days`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">AI analysis</dt>
              <dd className="mt-1 font-semibold">
                {policy.aiEnabled ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">File storage</dt>
              <dd className="mt-1 font-semibold">
                {policy.storageEnabled ? "Enabled" : "Disabled"}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section
        aria-labelledby="workspace-activity-heading"
        className={panelClassName}
      >
        <SectionHeader
          id="workspace-activity-heading"
          title="Workspace activity"
          {...(canReadActivity
            ? { href: "/settings/audit", linkLabel: "View audit log" }
            : {})}
        />
        {!canReadActivity ? (
          <p className="text-muted-foreground mt-4 text-sm">
            Activity is managed by workspace administrators.
          </p>
        ) : activity?.length ? (
          <ul aria-label="Workspace activity" className="mt-4 divide-y">
            {activity.map((event, index) => (
              <li
                key={`${event.occurredAt}-${event.action}-${index}`}
                className="py-4 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{humanize(event.action)}</p>
                    <p className="text-muted-foreground mt-1 text-xs [overflow-wrap:anywhere] break-words">
                      {event.actorLabel} ({humanize(event.actorKind)}) ·{" "}
                      {humanize(event.resourceKind)}
                    </p>
                  </div>
                  <Badge variant="neutral">{humanize(event.outcome)}</Badge>
                </div>
                <p className="text-muted-foreground mt-2 text-xs">
                  <time dateTime={event.occurredAt}>
                    {displayDate(event.occurredAt)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4">
            <EmptyState>
              No workspace activity has been recorded yet.
            </EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}
