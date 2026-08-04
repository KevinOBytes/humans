import { notFound } from "next/navigation";

import { EvidenceAssociationForm } from "@/components/research/research-record-forms";
import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  FactEvidenceDocument,
  PageDetailsFragmentDoc,
  PersonEvidenceFactsDocument,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import {
  cursorParam,
  type SearchState,
  uuidParam,
} from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

export async function EvidenceSection({
  canCreate,
  personId,
  search,
}: {
  canCreate: boolean;
  personId: string;
  search: SearchState;
}) {
  const factAfter = cursorParam(search, "evidenceFactAfter");
  const factOptionAfter = cursorParam(search, "evidenceFactOptionAfter");
  const requestedFact = uuidParam(search, "evidenceFact");
  const evidenceAfter = cursorParam(search, "evidenceAfter");
  const [data, optionData] = await Promise.all([
    executeServerGraphQL(PersonEvidenceFactsDocument, {
      id: personId,
      first: 5,
      after: factAfter,
    }),
    canCreate
      ? executeServerGraphQL(PersonEvidenceFactsDocument, {
          id: personId,
          first: 25,
          after: factOptionAfter,
        })
      : Promise.resolve(null),
  ]);
  if (!data.person) notFound();
  const facts = (data.person.facts?.nodes ?? []).filter((fact) => fact?.id);
  const detailAnchor = facts.some((fact) => fact?.id === requestedFact)
    ? requestedFact
    : undefined;
  const details = await Promise.all(
    facts.map((fact) =>
      executeServerGraphQL(FactEvidenceDocument, {
        id: fact!.id!,
        first: 3,
        after: fact!.id === detailAnchor ? evidenceAfter : undefined,
      }),
    ),
  );
  const detailsById = new Map(
    details.flatMap((detail) =>
      detail.fact ? [[detail.fact.id, detail.fact]] : [],
    ),
  );
  const factOptions = (optionData?.person?.facts?.nodes ?? []).flatMap(
    (fact) => (fact?.id ? [{ id: fact.id, label: fact.label ?? "Fact" }] : []),
  );
  const factPage = readFragment(
    PageDetailsFragmentDoc,
    data.person.facts?.pageInfo,
  );
  const optionPage = readFragment(
    PageDetailsFragmentDoc,
    optionData?.person?.facts?.pageInfo,
  );

  return (
    <div className="space-y-7">
      {canCreate ? (
        <section
          aria-labelledby="evidence-editor-heading"
          className="space-y-3"
        >
          <h2 id="evidence-editor-heading" className="sr-only">
            Evidence editor
          </h2>
          <EvidenceAssociationForm facts={factOptions} />
          <PageControls
            label="Evidence fact options"
            resetHref={
              factOptionAfter
                ? profilePageHref(personId, "evidence", {
                    evidenceFactAfter: factAfter,
                  })
                : null
            }
            nextHref={
              optionPage?.hasNextPage && optionPage.endCursor
                ? profilePageHref(personId, "evidence", {
                    evidenceFactAfter: factAfter,
                    evidenceFactOptionAfter: optionPage.endCursor,
                  })
                : null
            }
            nextLabel="More facts to link"
          />
        </section>
      ) : null}
      <ResearchList title="Evidence" empty="No visible facts are on this page.">
        {facts.map((fact) => {
          const detail = detailsById.get(fact!.id!);
          const pageInfo = readFragment(
            PageDetailsFragmentDoc,
            detail?.evidence?.pageInfo,
          );
          const items = (detail?.evidence?.nodes ?? []).flatMap((item) =>
            item?.id && item.evidenceItem?.source?.title ? [item] : [],
          );
          return (
            <li
              key={fact!.id!}
              className="border-border bg-card rounded-xl border p-4"
            >
              <h3 className="font-semibold">{fact!.label ?? "Fact"}</h3>
              {items.length ? (
                <ul className="mt-3 grid gap-3">
                  {items.map((item) => (
                    <li key={item.id} className="bg-muted rounded-lg p-3">
                      <p className="font-semibold">
                        {item.evidenceItem!.source!.title}
                      </p>
                      {item.locator ? (
                        <p className="text-muted-foreground mt-1 text-sm">
                          {item.locator}
                        </p>
                      ) : null}
                      {item.excerpt ? (
                        <blockquote className="border-primary mt-3 border-l-2 pl-3 text-sm whitespace-pre-wrap">
                          {item.excerpt}
                        </blockquote>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground mt-2 text-sm">
                  No linked evidence on this page.
                </p>
              )}
              <PageControls
                label={`Evidence for ${fact!.label ?? "fact"}`}
                resetHref={
                  fact!.id === detailAnchor && evidenceAfter
                    ? profilePageHref(personId, "evidence", {
                        evidenceFactAfter: factAfter,
                        evidenceFactOptionAfter: factOptionAfter,
                        evidenceFact: fact!.id!,
                      })
                    : null
                }
                nextHref={
                  pageInfo?.hasNextPage && pageInfo.endCursor
                    ? profilePageHref(personId, "evidence", {
                        evidenceFactAfter: factAfter,
                        evidenceFactOptionAfter: factOptionAfter,
                        evidenceFact: fact!.id!,
                        evidenceAfter: pageInfo.endCursor,
                      })
                    : null
                }
                nextLabel={`More evidence for ${fact!.label ?? "fact"}`}
              />
            </li>
          );
        })}
      </ResearchList>
      <PageControls
        label="Evidence facts"
        resetHref={factAfter ? profilePageHref(personId, "evidence") : null}
        nextHref={
          factPage?.hasNextPage && factPage.endCursor
            ? profilePageHref(personId, "evidence", {
                evidenceFactAfter: factPage.endCursor,
                evidenceFactOptionAfter: factOptionAfter,
              })
            : null
        }
        nextLabel="Next evidence facts page"
      />
    </div>
  );
}
