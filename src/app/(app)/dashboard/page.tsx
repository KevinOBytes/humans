import Link from "next/link";

import { getAppContext } from "@/app/(app)/app-session";
import { PeopleTable } from "@/components/people/people-table";
import { buttonVariants } from "@/components/ui/button";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  DashboardPeopleDocument,
  PersonSummaryFragmentDoc,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export default async function DashboardPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const data = await executeServerGraphQL(DashboardPeopleDocument, {
    first: 8,
  });
  const people = readFragment(PersonSummaryFragmentDoc, data.people.nodes);
  const canCreate = context.viewer.permissions.includes("person:create");
  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-primary text-sm font-semibold">
            {context.viewer.workspace.name}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Research dashboard
          </h1>
          <p className="text-muted-foreground mt-3 text-sm">
            Signed in as {context.viewer.role ?? "member"}. Continue the
            workspace&apos;s most recently updated visible records.
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/people/new"
            className={buttonVariants({ variant: "default" })}
          >
            Add person
          </Link>
        ) : null}
      </header>
      <section aria-labelledby="continue-research-heading">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2
              id="continue-research-heading"
              className="text-xl font-semibold"
            >
              Continue research
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Recently updated visible people
            </p>
          </div>
          <Link
            href="/people"
            className="text-primary text-sm font-semibold underline-offset-4 hover:underline"
          >
            View all people
          </Link>
        </div>
        <PeopleTable
          hasFilters={false}
          nextHref={null}
          people={people.map((person) => ({
            id: person.id,
            displayName: person.displayName,
            preferredName: person.preferredName,
            status: person.status,
            sensitivity: person.sensitivity,
            updatedAt: person.updatedAt,
            version: person.version,
          }))}
        />
      </section>
    </div>
  );
}
