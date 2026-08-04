import Link from "next/link";
import { notFound } from "next/navigation";

import { RelationshipForm } from "@/components/relationships/relationship-form";
import { relationshipPresentation } from "@/components/relationships/relationship-presentation";
import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PageDetailsFragmentDoc,
  PeopleOptionsDocument,
  PersonIdentityDocument,
  PersonRelationshipsDocument,
  RelationshipTypeDetailDocument,
  RelationshipTypeOptionsDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import {
  cursorParam,
  personIdPattern,
  type SearchState,
  stringParam,
} from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

export async function RelationshipsSection({
  canCreate,
  personId,
  search,
}: {
  canCreate: boolean;
  personId: string;
  search: SearchState;
}) {
  const relationshipAfter = cursorParam(search, "relationshipAfter");
  const typeAfter = cursorParam(search, "relationshipTypeAfter");
  const personAfter = cursorParam(search, "relationshipPersonAfter");
  const personSearch = stringParam(search, "relationshipPersonSearch")
    ?.trim()
    .slice(0, 100);
  const [data, typeOptions, peopleOptions] = await Promise.all([
    executeServerGraphQL(PersonRelationshipsDocument, {
      id: personId,
      first: 10,
      after: relationshipAfter,
    }),
    canCreate
      ? executeServerGraphQL(RelationshipTypeOptionsDocument, {
          first: 25,
          after: typeAfter,
        })
      : Promise.resolve(null),
    canCreate
      ? executeServerGraphQL(PeopleOptionsDocument, {
          first: 25,
          after: personAfter,
          filter: personSearch ? { nameContains: personSearch } : undefined,
        })
      : Promise.resolve(null),
  ]);
  if (!data.person) notFound();
  const relationships = (data.person.relationships?.nodes ?? []).filter(
    (relationship) => relationship?.id,
  );
  const typeIds = [
    ...new Set(
      relationships.flatMap((relationship) =>
        relationship?.relationshipTypeId
          ? [relationship.relationshipTypeId]
          : [],
      ),
    ),
  ];
  const typeDetails = await Promise.all(
    typeIds.map((id) =>
      executeServerGraphQL(RelationshipTypeDetailDocument, { id }),
    ),
  );
  const typeById = new Map(
    typeDetails.flatMap((detail) =>
      detail.relationshipType?.id
        ? [[detail.relationshipType.id, detail.relationshipType]]
        : [],
    ),
  );
  const presentations = relationships.map((relationship) => ({
    relationship: relationship!,
    ...relationshipPresentation({
      relationship: relationship!,
      type: typeById.get(relationship!.relationshipTypeId ?? ""),
      viewedPersonId: personId,
    }),
  }));
  const counterpartIds = [
    ...new Set(
      presentations.flatMap((item) =>
        item.counterpartId && personIdPattern.test(item.counterpartId)
          ? [item.counterpartId]
          : [],
      ),
    ),
  ];
  const counterpartData = await Promise.all(
    counterpartIds.map((id) =>
      executeServerGraphQL(PersonIdentityDocument, { id }),
    ),
  );
  const counterpartById = new Map(
    counterpartData.flatMap((result) =>
      result.person ? [[result.person.id, result.person.displayName]] : [],
    ),
  );
  const relationshipTypes = (
    typeOptions?.relationshipTypes?.nodes ?? []
  ).flatMap((type) =>
    type?.id
      ? [{ id: type.id, label: type.forwardLabel ?? type.key ?? "Related" }]
      : [],
  );
  const people = (peopleOptions?.people.nodes ?? []).map((person) => ({
    id: person.id,
    name: person.displayName,
  }));
  const relationshipPage = readFragment(
    PageDetailsFragmentDoc,
    data.person.relationships?.pageInfo,
  );
  const typePage = readFragment(
    PageDetailsFragmentDoc,
    typeOptions?.relationshipTypes?.pageInfo,
  );
  const peoplePage = readFragment(
    PageDetailsFragmentDoc,
    peopleOptions?.people.pageInfo,
  );
  const commonOptions = {
    relationshipAfter,
    relationshipTypeAfter: typeAfter,
    relationshipPersonAfter: personAfter,
    relationshipPersonSearch: personSearch,
  };

  return (
    <div className="space-y-7">
      {canCreate ? (
        <section
          aria-labelledby="relationship-editor-heading"
          className="space-y-4"
        >
          <h2 id="relationship-editor-heading" className="sr-only">
            Relationship editor
          </h2>
          <form
            method="get"
            aria-label="Find a related person"
            className="border-border bg-card flex flex-wrap items-end gap-3 rounded-xl border p-4"
          >
            <input type="hidden" name="view" value="relationships" />
            <div className="min-w-56 flex-1 space-y-2">
              <label
                htmlFor="relationship-person-search"
                className="text-sm font-medium"
              >
                Find a related person
              </label>
              <Input
                id="relationship-person-search"
                name="relationshipPersonSearch"
                defaultValue={personSearch}
                placeholder="Name contains"
              />
            </div>
            <button className={buttonVariants({ variant: "secondary" })}>
              Search people
            </button>
          </form>
          <RelationshipForm
            sourcePersonId={personId}
            relationshipTypes={relationshipTypes}
            people={people}
          />
          <PageControls
            label="Relationship type options"
            resetHref={
              typeAfter
                ? profilePageHref(personId, "relationships", {
                    ...commonOptions,
                    relationshipTypeAfter: undefined,
                  })
                : null
            }
            nextHref={
              typePage?.hasNextPage && typePage.endCursor
                ? profilePageHref(personId, "relationships", {
                    ...commonOptions,
                    relationshipTypeAfter: typePage.endCursor,
                  })
                : null
            }
            nextLabel="More relationship types"
          />
          <PageControls
            label="Related person options"
            resetHref={
              personAfter
                ? profilePageHref(personId, "relationships", {
                    ...commonOptions,
                    relationshipPersonAfter: undefined,
                  })
                : null
            }
            nextHref={
              peoplePage?.hasNextPage && peoplePage.endCursor
                ? profilePageHref(personId, "relationships", {
                    ...commonOptions,
                    relationshipPersonAfter: peoplePage.endCursor,
                  })
                : null
            }
            nextLabel="More related people"
          />
        </section>
      ) : null}
      <ResearchList
        title="Relationships"
        empty="No relationships have been recorded."
      >
        {presentations.map((item) => {
          const counterpartName = item.counterpartId
            ? counterpartById.get(item.counterpartId)
            : undefined;
          return (
            <li
              key={item.relationship.id!}
              className="border-border bg-card rounded-xl border p-4"
            >
              <p className="font-semibold">{item.label}</p>
              <p className="text-muted-foreground mt-2 text-sm">
                {counterpartName && item.counterpartId ? (
                  <Link
                    className="text-primary font-semibold underline-offset-4 hover:underline"
                    href={`/people/${item.counterpartId}`}
                  >
                    {counterpartName}
                  </Link>
                ) : (
                  "Related person unavailable"
                )}
              </p>
              <div className="mt-3 flex gap-2">
                <Badge>{item.relationship.state ?? "active"}</Badge>
                <Badge>
                  {item.relationship.sensitivity?.toLowerCase() ?? "internal"}
                </Badge>
              </div>
            </li>
          );
        })}
      </ResearchList>
      <PageControls
        label="Relationships"
        resetHref={
          relationshipAfter
            ? profilePageHref(personId, "relationships", {
                ...commonOptions,
                relationshipAfter: undefined,
              })
            : null
        }
        nextHref={
          relationshipPage?.hasNextPage && relationshipPage.endCursor
            ? profilePageHref(personId, "relationships", {
                ...commonOptions,
                relationshipAfter: relationshipPage.endCursor,
              })
            : null
        }
        nextLabel="Next relationships page"
      />
    </div>
  );
}
