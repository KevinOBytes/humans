import { notFound } from "next/navigation";

import { PersonRecordEditor } from "@/components/people/person-record-editor";
import {
  PersonEventRowEditor,
  PersonNameRowEditor,
} from "@/components/people/person-record-row-editor";
import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { Badge } from "@/components/ui/badge";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  PersonEventSummaryFragmentDoc,
  PersonIdentifierSummaryFragmentDoc,
  PersonNameSummaryFragmentDoc,
  PersonEventsDocument,
  PersonIdentifiersDocument,
  PersonNamesDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { cursorParam, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

type TemporalPrecision =
  | "INSTANT"
  | "SECOND"
  | "MINUTE"
  | "HOUR"
  | "DAY"
  | "MONTH"
  | "YEAR"
  | "RANGE"
  | "UNKNOWN"
  | string
  | null
  | undefined;

type TemporalSemantics =
  | "EXACT"
  | "APPROXIMATE"
  | "BEFORE"
  | "AFTER"
  | "BETWEEN"
  | "YEAR_ONLY"
  | "UNKNOWN"
  | string
  | null
  | undefined;

function dateParts(value: string): {
  year: number;
  month?: number;
  day?: number;
} {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value);
  if (!match) {
    const parsed = new Date(value);
    return {
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
      day: parsed.getUTCDate(),
    };
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: match[3] ? Number(match[3]) : undefined,
  };
}

function dateLabel(
  value: string | null | undefined,
  precision: TemporalPrecision = "UNKNOWN",
  semantics: TemporalSemantics = "UNKNOWN",
): string {
  if (!value) return "Date unknown";
  const parts = dateParts(value);
  const year = String(parts.year);
  let label: string;
  if (precision === "YEAR" || semantics === "YEAR_ONLY") {
    label = year;
  } else if (precision === "MONTH" || parts.day === undefined) {
    label = new Intl.DateTimeFormat("en", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(parts.year, (parts.month ?? 1) - 1, 1)));
  } else {
    label = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(
      new Date(Date.UTC(parts.year, (parts.month ?? 1) - 1, parts.day)),
    );
  }
  if (semantics === "APPROXIMATE") return `about ${label}`;
  if (semantics === "BEFORE") return `before ${label}`;
  if (semantics === "AFTER") return `after ${label}`;
  return label;
}

export async function NamesTimelineSection({
  personId,
  search,
  canUpdate = false,
  canDelete = false,
}: {
  personId: string;
  search: SearchState;
  canUpdate?: boolean;
  canDelete?: boolean;
}) {
  const namesAfter = cursorParam(search, "nameAfter");
  const eventsAfter = cursorParam(search, "eventAfter");
  const identifiersAfter = cursorParam(search, "identifierAfter");
  const [namesData, eventsData, identifiersData] = await Promise.all([
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
    executeServerGraphQL(PersonIdentifiersDocument, {
      id: personId,
      first: 10,
      after: identifiersAfter,
    }),
  ]);
  if (!namesData.person || !eventsData.person || !identifiersData.person)
    notFound();

  const names = (namesData.person.names?.nodes ?? [])
    .filter(Boolean)
    .map((node) => readFragment(PersonNameSummaryFragmentDoc, node));
  const events = (eventsData.person.events?.nodes ?? [])
    .filter(Boolean)
    .map((node) => readFragment(PersonEventSummaryFragmentDoc, node));
  const identifiers = (identifiersData.person.identifiers?.nodes ?? [])
    .filter(Boolean)
    .map((node) => readFragment(PersonIdentifierSummaryFragmentDoc, node));
  const namesPage = readFragment(
    PageDetailsFragmentDoc,
    namesData.person.names?.pageInfo,
  );
  const eventsPage = readFragment(
    PageDetailsFragmentDoc,
    eventsData.person.events?.pageInfo,
  );
  const identifiersPage = readFragment(
    PageDetailsFragmentDoc,
    identifiersData.person.identifiers?.pageInfo,
  );

  return (
    <div className="space-y-7">
      {canUpdate ? <PersonRecordEditor personId={personId} /> : null}
      <section className="space-y-3">
        <ResearchList
          title="Identifiers"
          empty="No authorized identifiers have been recorded."
        >
          {identifiers.map((identifier) => (
            <li
              key={identifier.id}
              className="border-border bg-card rounded-2xl border p-4"
              aria-label={`${identifier.identifierType} identifier`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    {identifier.namespace}
                  </p>
                  <h3 className="mt-1 font-semibold">
                    {identifier.identifierType}
                  </h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge>{identifier.verificationState.toLowerCase()}</Badge>
                  {identifier.redacted ? <Badge>value redacted</Badge> : null}
                </div>
              </div>
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Issuer</dt>
                  <dd className="mt-1">
                    {identifier.issuer ?? "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Value</dt>
                  <dd className="mt-1 font-mono break-all">
                    {identifier.value ?? "Redacted by sensitivity policy"}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ResearchList>
        <PageControls
          label="Person identifiers"
          resetHref={
            identifiersAfter
              ? profilePageHref(personId, "names", {
                  nameAfter: namesAfter,
                  eventAfter: eventsAfter,
                })
              : null
          }
          nextHref={
            identifiersPage?.hasNextPage && identifiersPage.endCursor
              ? profilePageHref(personId, "names", {
                  nameAfter: namesAfter,
                  eventAfter: eventsAfter,
                  identifierAfter: identifiersPage.endCursor,
                })
              : null
          }
          nextLabel="More identifiers"
        />
      </section>
      <section className="space-y-3">
        <ResearchList
          title="Names"
          empty="No visible names have been recorded."
        >
          {names.map((name) => (
            <PersonNameRowEditor
              key={name.id}
              name={name}
              canUpdate={canUpdate}
              canDelete={canDelete}
              dateLabel={
                name.validFrom || name.validUntil
                  ? `${dateLabel(name.validFrom, name.temporalPrecision, name.temporalSemantics)} – ${dateLabel(name.validUntil, name.temporalPrecision, name.temporalSemantics)}`
                  : ""
              }
            />
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
            <PersonEventRowEditor
              key={event.id}
              event={event}
              canUpdate={canUpdate}
              canDelete={canDelete}
              dateLabel={`${dateLabel(event.earliestAt, event.temporalPrecision, event.temporalSemantics)}${event.latestAt ? ` – ${dateLabel(event.latestAt, event.temporalPrecision, event.temporalSemantics)}` : ""}`}
            />
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
