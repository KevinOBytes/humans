import Link from "next/link";

import { getAppContext } from "@/app/(app)/app-session";
import { CollaborationTeamDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export const dynamic = "force-dynamic";

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const { teamId } = await params;
  const result = await executeServerGraphQL(CollaborationTeamDocument, {
    id: teamId,
  });
  if (!result.team) return null;
  return (
    <div className="space-y-6">
      <Link
        href="/settings/teams"
        className="text-muted-foreground hover:text-foreground text-sm"
      >
        ← Teams
      </Link>
      <header>
        <p className="text-primary text-sm font-semibold">
          Workspace collaboration
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {result.team.name}
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
          {result.team.description ?? "No team description has been recorded."}
        </p>
      </header>
      <div className="border-border bg-muted/40 rounded-2xl border p-5 text-sm">
        <p className="font-semibold">Team record</p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground text-xs uppercase">State</dt>
            <dd className="mt-1">{result.team.state}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">Version</dt>
            <dd className="mt-1">{result.team.version}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs uppercase">ID</dt>
            <dd
              className="mt-1 truncate font-mono text-xs"
              title={result.team.id ?? undefined}
            >
              {result.team.id}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
