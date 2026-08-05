import Link from "next/link";
import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { ActivitySection } from "@/components/activity/activity-section";
import { EvidenceSection } from "@/components/evidence/evidence-section";
import { FactsSection } from "@/components/facts/facts-section";
import { NotesSection } from "@/components/notes/notes-section";
import { ContactsPlacesSection } from "@/components/locations/contacts-places-section";
import { PersonEditForm } from "@/components/people/person-edit-form";
import { NamesTimelineSection } from "@/components/people/names-timeline-section";
import { RelationshipsSection } from "@/components/relationships/relationships-section";
import { Badge } from "@/components/ui/badge";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PersonHeaderDocument,
  PersonSummaryFragmentDoc,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { personIdPattern, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

const views = [
  "facts",
  "names",
  "relationships",
  "evidence",
  "notes",
  "activity",
  "contacts",
] as const;
type View = (typeof views)[number];

export async function PersonRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>;
  searchParams: Promise<SearchState>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const { personId } = await params;
  if (!personIdPattern.test(personId)) notFound();
  const search = await searchParams;
  const requested = search.view;
  const view: View =
    typeof requested === "string" && views.includes(requested as View)
      ? (requested as View)
      : "facts";
  if (view === "activity" && !context.viewer.permissions.includes("audit:read"))
    notFound();

  const headerData = await executeServerGraphQL(PersonHeaderDocument, {
    id: personId,
  });
  if (!headerData.person) notFound();
  const person = readFragment(PersonSummaryFragmentDoc, headerData.person);
  const visibleViews = views.filter(
    (candidate) =>
      candidate !== "activity" ||
      context.viewer?.permissions.includes("audit:read"),
  );
  const permissions = context.viewer.permissions;

  return (
    <div className="space-y-7">
      <header className="border-border bg-card rounded-2xl border p-6 shadow-sm">
        <p className="text-primary text-xs font-semibold tracking-[0.16em] uppercase">
          Person record
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {person.displayName}
            </h1>
            {person.preferredName ? (
              <p className="text-muted-foreground mt-2 text-sm">
                Preferred name: {person.preferredName}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Badge>{person.status.toLowerCase()}</Badge>
            <Badge>{person.sensitivity.toLowerCase()}</Badge>
          </div>
        </div>
        {person.biography ? (
          <p className="text-muted-foreground mt-5 max-w-3xl text-sm leading-6 whitespace-pre-wrap">
            {person.biography}
          </p>
        ) : null}
        {permissions.includes("person:update") ? (
          <PersonEditForm person={person} />
        ) : null}
      </header>
      <nav
        aria-label="Person research sections"
        className="border-border overflow-x-auto border-b"
      >
        <ul className="flex min-w-max gap-1">
          {visibleViews.map((candidate) => (
            <li key={candidate}>
              <Link
                href={profilePageHref(personId, candidate)}
                aria-current={view === candidate ? "page" : undefined}
                className="text-muted-foreground hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-primary block min-h-11 rounded-t-lg border-b-2 border-transparent px-4 py-3 text-sm font-semibold capitalize"
              >
                {candidate === "notes"
                  ? "Notes & tags"
                  : candidate === "names"
                    ? "Names & timeline"
                    : candidate === "contacts"
                      ? "Contacts & places"
                      : candidate}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {view === "facts" ? (
        <FactsSection
          search={search}
          personId={personId}
          person={person}
          canCreate={permissions.includes("fact:create")}
          canSelect={permissions.includes("fact:select")}
        />
      ) : null}
      {view === "names" ? (
        <NamesTimelineSection search={search} personId={personId} />
      ) : null}
      {view === "relationships" ? (
        <RelationshipsSection
          search={search}
          personId={personId}
          canCreate={permissions.includes("relationship:create")}
        />
      ) : null}
      {view === "evidence" ? (
        <EvidenceSection
          search={search}
          personId={personId}
          canCreate={
            permissions.includes("evidence:create") &&
            permissions.includes("source:create")
          }
        />
      ) : null}
      {view === "notes" ? (
        <NotesSection
          search={search}
          personId={personId}
          canCreateNote={permissions.includes("note:create")}
          canApplyTag={
            permissions.includes("tag:read") &&
            permissions.includes("tag:update") &&
            permissions.includes("person:update")
          }
          canCreateTag={permissions.includes("tag:create")}
        />
      ) : null}
      {view === "activity" ? (
        <ActivitySection search={search} personId={personId} />
      ) : null}
      {view === "contacts" ? (
        <ContactsPlacesSection
          search={search}
          personId={personId}
          canCreateContact={permissions.includes("contactPoint:create")}
          canUpdateContact={permissions.includes("contactPoint:update")}
          canDeleteContact={permissions.includes("contactPoint:delete")}
          canCreateAddress={permissions.includes("address:create")}
          canUpdateAddress={permissions.includes("address:update")}
          canDeleteAddress={permissions.includes("address:delete")}
          canReadPlaces={permissions.includes("place:read")}
          canCreatePlace={permissions.includes("place:create")}
          canUpdatePlace={permissions.includes("place:update")}
          canDeletePlace={permissions.includes("place:delete")}
        />
      ) : null}
    </div>
  );
}
