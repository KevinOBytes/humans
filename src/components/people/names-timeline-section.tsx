import { notFound } from "next/navigation";

import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { Badge } from "@/components/ui/badge";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  PersonEventSummaryFragmentDoc,
  PersonNameSummaryFragmentDoc,
  PersonEventsDocument,
  PersonNamesDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { cursorParam, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Date unknown";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
    new Date(value),
  );
}

export async function NamesTimelineSection({
  personId,
  search,
}: {
  personId: string;
  search: SearchState;
}) {
  const namesAfter = cursorParam(search, "nameAfter");
  const eventsAfter = cursorParam(search, "eventAfter");
  const [namesData, eventsData] = await Promise.all([
    executeServerGraphQL(PersonNamesDocument, {
      id: personId,
      first: 5,
      after: namesAfter,
    }),
    executeServerGraphQL(PersonEventsDocument, {
      id: personId,
      first: 5,
      after: eventsAfter,
    }),
  ]);
  if (!namesData.person || !eventsData.person) notFound();

  const names = (namesData.person.names?.nodes ?? [])
    .filter(Boolean)
    .map((node) => readFragment(PersonNameSummaryFragmentDoc, node));
  const events = (eventsData.person.events?.nodes ?? [])
    .filter(Boolean)
    .map((node) => readFragment(PersonEventSummaryFragmentDoc, node));
  const namesPage = readFragment(
    PageDetailsFragmentDoc,
    namesData.person.names?.pageInfo,
  );
  const eventsPage = readFragment(
    PageDetailsFragmentDoc,
    eventsData.person.events?.pageInfo,
  );

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <ResearchList
          title="Names"
          empty="No visible names have been recorded."
        >
          {names.map((name) => (
            <li
              key={name.id}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{name.fullName}</h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {name.kind.toLowerCase()}
                    {name.validFrom || name.validUntil
                      ? ` · ${dateLabel(name.validFrom)} – ${dateLabel(name.validUntil)}`
                      : ""}
                  </p>
                </div>
                <Badge>{name.state.toLowerCase()}</Badge>
              </div>
              {name.givenName || name.familyName ? (
                <p className="text-muted-foreground mt-3 text-sm">
                  {[name.givenName, name.middleName, name.familyName]
                    .filter(Boolean)
                    .join(" ")}
                </p>
              ) : null}
            </li>
          ))}
        </ResearchList>
        <PageControls
          label="Person names"
          resetHref={
            namesAfter
              ? profilePageHref(personId, "names", { eventAfter: eventsAfter })
              : null
          }
          nextHref={
            namesPage?.hasNextPage && namesPage.endCursor
              ? profilePageHref(personId, "names", {
                  nameAfter: namesPage.endCursor,
                  eventAfter: eventsAfter,
                })
              : null
          }
          nextLabel="More names"
        />
      </section>

      <section className="space-y-3">
        <ResearchList
          title="Timeline"
          empty="No visible timeline events have been recorded."
        >
          {events.map((event) => (
            <li
              key={event.id}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{event.title}</h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {event.eventKind} · {dateLabel(event.earliestAt)}
                    {event.latestAt ? ` – ${dateLabel(event.latestAt)}` : ""}
                  </p>
                </div>
                <Badge>{event.state.toLowerCase()}</Badge>
              </div>
              {event.description ? (
                <p className="text-muted-foreground mt-3 text-sm leading-6 whitespace-pre-wrap">
                  {event.description}
                </p>
              ) : null}
            </li>
          ))}
        </ResearchList>
        <PageControls
          label="Person timeline"
          resetHref={
            eventsAfter
              ? profilePageHref(personId, "names", { nameAfter: namesAfter })
              : null
          }
          nextHref={
            eventsPage?.hasNextPage && eventsPage.endCursor
              ? profilePageHref(personId, "names", {
                  nameAfter: namesAfter,
                  eventAfter: eventsPage.endCursor,
                })
              : null
          }
          nextLabel="More timeline events"
        />
      </section>
    </div>
  );
}
