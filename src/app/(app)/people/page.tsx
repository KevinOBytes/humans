import Link from "next/link";

import { getAppContext } from "@/app/(app)/app-session";
import { PeopleTable } from "@/components/people/people-table";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  PeopleListDocument,
  PersonSummaryFragmentDoc,
  type PersonFilterInput,
  type PersonStatus,
  type Sensitivity,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

const statuses = new Set<PersonStatus>([
  "ACTIVE",
  "ARCHIVED",
  "DECEASED",
  "MERGED",
  "MISSING",
  "UNKNOWN",
]);
const sensitivities = new Set<Sensitivity>([
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
]);

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const params = await searchParams;
  const name =
    typeof params.name === "string" ? params.name.trim().slice(0, 100) : "";
  const rawStatus =
    typeof params.status === "string" ? params.status.toUpperCase() : "";
  const rawSensitivity =
    typeof params.sensitivity === "string"
      ? params.sensitivity.toUpperCase()
      : "";
  const after =
    typeof params.after === "string" && params.after.length <= 512
      ? params.after
      : undefined;
  const filter: PersonFilterInput = {
    ...(name ? { nameContains: name } : {}),
    ...(statuses.has(rawStatus as PersonStatus)
      ? { status: rawStatus as PersonStatus }
      : {}),
    ...(sensitivities.has(rawSensitivity as Sensitivity)
      ? { sensitivity: rawSensitivity as Sensitivity }
      : {}),
  };
  const data = await executeServerGraphQL(PeopleListDocument, {
    first: 25,
    after,
    filter: Object.keys(filter).length ? filter : undefined,
  });
  const people = readFragment(PersonSummaryFragmentDoc, data.people.nodes);
  const pageInfo = readFragment(PageDetailsFragmentDoc, data.people.pageInfo);
  const next = new URLSearchParams();
  if (name) next.set("name", name);
  if (statuses.has(rawStatus as PersonStatus)) next.set("status", rawStatus);
  if (sensitivities.has(rawSensitivity as Sensitivity))
    next.set("sensitivity", rawSensitivity);
  if (pageInfo.hasNextPage && pageInfo.endCursor)
    next.set("after", pageInfo.endCursor);
  const canCreate = context.viewer.permissions.includes("person:create");
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">People</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Visible person records in this verified workspace.
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
      <form
        aria-label="Filter people"
        className="border-border bg-card grid gap-3 rounded-2xl border p-4 sm:grid-cols-[minmax(12rem,1fr)_12rem_12rem_auto]"
        method="get"
      >
        <div>
          <label className="sr-only" htmlFor="name">
            Name contains
          </label>
          <Input
            id="name"
            name="name"
            defaultValue={name}
            placeholder="Name contains"
          />
        </div>
        <div>
          <label className="sr-only" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={rawStatus}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="">Any status</option>
            {[...statuses].map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="sr-only" htmlFor="sensitivity">
            Sensitivity
          </label>
          <select
            id="sensitivity"
            name="sensitivity"
            defaultValue={rawSensitivity}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
          >
            <option value="">Any sensitivity</option>
            {[...sensitivities].map((sensitivity) => (
              <option key={sensitivity}>{sensitivity}</option>
            ))}
          </select>
        </div>
        <button
          className={buttonVariants({ variant: "secondary" })}
          type="submit"
        >
          Apply filters
        </button>
      </form>
      <PeopleTable
        people={people.map((person) => ({
          id: person.id,
          displayName: person.displayName,
          preferredName: person.preferredName,
          status: person.status,
          sensitivity: person.sensitivity,
          updatedAt: person.updatedAt,
          version: person.version,
        }))}
        hasFilters={Object.keys(filter).length > 0}
        nextHref={
          pageInfo.hasNextPage && pageInfo.endCursor
            ? `/people?${next.toString()}`
            : null
        }
      />
    </div>
  );
}
