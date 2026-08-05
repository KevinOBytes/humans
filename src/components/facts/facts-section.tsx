import { notFound } from "next/navigation";

import { factDisplayValue } from "@/components/facts/fact-display-value";
import { FactForm, FactSelectionButton } from "@/components/facts/fact-form";
import { PersonProfile } from "@/components/people/person-profile";
import { PageControls } from "@/components/research/paginated-research-list";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  FactCatalogDocument,
  FactDetailDocument,
  FactSummaryFragmentDoc,
  PageDetailsFragmentDoc,
  PersonFactsDocument,
  PersonFieldSelectionsDocument,
  type PersonSummaryFragment,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import {
  cursorParam,
  type SearchState,
  uuidParam,
} from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";
import { readVerifiedFieldSelections } from "@/lib/verified-field-selections";

export async function FactsSection({
  canCreate,
  canSelect,
  personId,
  person,
  search,
}: {
  canCreate: boolean;
  canSelect: boolean;
  personId: string;
  person: PersonSummaryFragment;
  search: SearchState;
}) {
  const factAfter = cursorParam(search, "factAfter");
  const contradictoryAfter = cursorParam(search, "contradictoryAfter");
  const catalogAfter = cursorParam(search, "catalogAfter");
  const requestedDetail = uuidParam(search, "factDetail");
  const revisionAfter = cursorParam(search, "factRevisionAfter");
  const evidenceAfter = cursorParam(search, "factEvidenceAfter");
  const [data, catalog] = await Promise.all([
    executeServerGraphQL(PersonFactsDocument, {
      id: personId,
      first: 5,
      after: factAfter,
      contradictoryAfter,
    }),
    canCreate
      ? executeServerGraphQL(FactCatalogDocument, {
          first: 25,
          after: catalogAfter,
        })
      : Promise.resolve(null),
  ]);
  if (!data.person) notFound();
  const facts = (data.person.facts?.nodes ?? [])
    .map((node) => readFragment(FactSummaryFragmentDoc, node))
    .filter((fact) =>
      Boolean(fact.id && fact.namespace && fact.fieldKey && fact.label),
    );
  const detailAnchor = facts.some((fact) => fact.id === requestedDetail)
    ? requestedDetail
    : undefined;
  const [selectionState, ...details] = await Promise.all([
    readVerifiedFieldSelections(facts, async (after) => {
      const selectionData = await executeServerGraphQL(
        PersonFieldSelectionsDocument,
        { id: personId, first: 25, after },
      );
      const connection = selectionData.person?.fieldSelections;
      if (!connection) return null;
      const pageInfo = readFragment(
        PageDetailsFragmentDoc,
        connection.pageInfo,
      );
      return {
        nodes: connection.nodes ?? [],
        hasNextPage: pageInfo?.hasNextPage ?? false,
        endCursor: pageInfo?.endCursor,
      };
    }),
    ...facts.map((fact) =>
      executeServerGraphQL(FactDetailDocument, {
        id: fact.id!,
        revisionFirst: 3,
        evidenceFirst: 3,
        revisionAfter: fact.id === detailAnchor ? revisionAfter : undefined,
        evidenceAfter: fact.id === detailAnchor ? evidenceAfter : undefined,
      }),
    ),
  ]);
  const detailsById = new Map(
    details.flatMap((detail) =>
      detail.fact ? [[detail.fact.id, detail.fact]] : [],
    ),
  );
  const actions = selectionState.verified
    ? Object.fromEntries(
        facts.flatMap((fact) => {
          const key = `${fact.namespace}:${fact.fieldKey}`;
          const selected = selectionState.byField.get(key);
          return fact.id && canSelect
            ? [
                [
                  fact.id,
                  <FactSelectionButton
                    key={fact.id}
                    personId={personId}
                    factId={fact.id}
                    namespace={fact.namespace!}
                    fieldKey={fact.fieldKey!}
                    selected={selected?.factId === fact.id}
                    expectedVersion={selected?.version}
                  />,
                ],
              ]
            : [];
        }),
      )
    : {};
  const definitions = (catalog?.factDefinitions?.nodes ?? []).flatMap(
    (definition) =>
      definition?.id && definition.label && definition.allowedValueType
        ? [
            {
              id: definition.id,
              label: definition.label,
              valueType: definition.allowedValueType,
              sensitivity:
                definition.defaultSensitivity ?? ("INTERNAL" as const),
            },
          ]
        : [],
  );
  const factPage = readFragment(
    PageDetailsFragmentDoc,
    data.person.facts?.pageInfo,
  );
  const contradictoryFacts = (data.person.contradictoryFacts?.nodes ?? [])
    .map((node) => readFragment(FactSummaryFragmentDoc, node))
    .filter((fact) => Boolean(fact.id && fact.label));
  const contradictoryPage = readFragment(
    PageDetailsFragmentDoc,
    data.person.contradictoryFacts?.pageInfo,
  );
  const catalogPage = readFragment(
    PageDetailsFragmentDoc,
    catalog?.factDefinitions?.pageInfo,
  );

  return (
    <div className="space-y-7">
      {canCreate ? (
        <section aria-labelledby="fact-editor-heading" className="space-y-3">
          <h2 id="fact-editor-heading" className="sr-only">
            Fact editor
          </h2>
          <FactForm definitions={definitions} personId={personId} />
          <PageControls
            label="Fact field options"
            resetHref={
              catalogAfter
                ? profilePageHref(personId, "facts", { factAfter })
                : null
            }
            nextHref={
              catalogPage?.hasNextPage && catalogPage.endCursor
                ? profilePageHref(personId, "facts", {
                    factAfter,
                    catalogAfter: catalogPage.endCursor,
                  })
                : null
            }
            nextLabel="More fact fields"
          />
        </section>
      ) : null}
      {!selectionState.verified ? (
        <p
          role="alert"
          className="border-disputed/40 bg-disputed/10 text-disputed-foreground rounded-xl border p-4 text-sm"
        >
          Presentation selections could not be completely verified. Claims
          remain visible, but selection badges and selection actions are
          disabled.
        </p>
      ) : null}
      {contradictoryFacts.length > 0 ? (
        <section
          aria-labelledby="contradictory-facts-heading"
          className="border-disputed/40 bg-disputed/10 rounded-xl border p-4"
        >
          <h2 id="contradictory-facts-heading" className="font-semibold">
            Contradictory claims
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Multiple active claims exist for the same field. Review the evidence
            and select an accepted presentation claim where needed.
          </p>
          <ul className="mt-3 grid gap-2">
            {contradictoryFacts.map((fact) => (
              <li
                key={fact.id}
                className="border-disputed/30 bg-background/70 rounded-lg border p-3 text-sm"
              >
                <span className="font-medium">{fact.label}</span>
                <span className="text-muted-foreground"> — </span>
                <span>{factDisplayValue(fact.value)}</span>
              </li>
            ))}
          </ul>
          <PageControls
            label="Contradictory claims"
            resetHref={
              contradictoryAfter
                ? profilePageHref(personId, "facts", { factAfter })
                : null
            }
            nextHref={
              contradictoryPage?.hasNextPage && contradictoryPage.endCursor
                ? profilePageHref(personId, "facts", {
                    factAfter,
                    contradictoryAfter: contradictoryPage.endCursor,
                  })
                : null
            }
            nextLabel="More contradictory claims"
          />
        </section>
      ) : null}
      <PersonProfile
        showHeader={false}
        actions={actions}
        person={{
          id: person.id,
          displayName: person.displayName,
          preferredName: person.preferredName,
          biography: person.biography,
          status: person.status,
          sensitivity: person.sensitivity,
          confidence: person.confidence,
          version: person.version,
          facts: facts.map((fact) => {
            const detail = detailsById.get(fact.id!);
            const key = `${fact.namespace}:${fact.fieldKey}`;
            const selected = selectionState.byField.get(key);
            const revisionPage = readFragment(
              PageDetailsFragmentDoc,
              detail?.revisions?.pageInfo,
            );
            const linkedEvidencePage = readFragment(
              PageDetailsFragmentDoc,
              detail?.evidence?.pageInfo,
            );
            const common = {
              factAfter,
              catalogAfter,
              factDetail: fact.id!,
            };
            return {
              id: fact.id!,
              namespace: fact.namespace!,
              fieldKey: fact.fieldKey!,
              label: fact.label!,
              value: factDisplayValue(fact.value),
              state: fact.state ?? "UNKNOWN",
              reviewState: fact.reviewState,
              sensitivity: fact.sensitivity ?? "INTERNAL",
              confidence: fact.confidence,
              temporalLabel: fact.temporalPrecision ?? fact.temporalSemantics,
              version: fact.version ?? 0,
              selected: selectionState.verified && selected?.factId === fact.id,
              selectionVerified: selectionState.verified,
              selectionVersion: selected?.version,
              revisions: (detail?.revisions?.nodes ?? []).flatMap((revision) =>
                revision?.id && revision.revision !== null && revision.createdAt
                  ? [
                      {
                        id: revision.id,
                        revision: revision.revision,
                        changeReason: revision.changeReason,
                        createdAt: revision.createdAt,
                        actorLabel: revision.createdBy?.label,
                      },
                    ]
                  : [],
              ),
              evidence: (detail?.evidence?.nodes ?? []).flatMap((evidence) =>
                evidence?.id && evidence.evidenceItem?.source?.title
                  ? [
                      {
                        id: evidence.id,
                        title: evidence.evidenceItem.source.title,
                        excerpt: evidence.excerpt,
                        locator: evidence.locator,
                        url: evidence.evidenceItem.source.canonicalUrl,
                      },
                    ]
                  : [],
              ),
              revisionResetHref:
                fact.id === detailAnchor && revisionAfter
                  ? profilePageHref(personId, "facts", {
                      ...common,
                      factEvidenceAfter: evidenceAfter,
                    })
                  : null,
              revisionNextHref:
                revisionPage?.hasNextPage && revisionPage.endCursor
                  ? profilePageHref(personId, "facts", {
                      ...common,
                      factRevisionAfter: revisionPage.endCursor,
                      factEvidenceAfter:
                        fact.id === detailAnchor ? evidenceAfter : undefined,
                    })
                  : null,
              evidenceResetHref:
                fact.id === detailAnchor && evidenceAfter
                  ? profilePageHref(personId, "facts", {
                      ...common,
                      factRevisionAfter: revisionAfter,
                    })
                  : null,
              evidenceNextHref:
                linkedEvidencePage?.hasNextPage && linkedEvidencePage.endCursor
                  ? profilePageHref(personId, "facts", {
                      ...common,
                      factRevisionAfter:
                        fact.id === detailAnchor ? revisionAfter : undefined,
                      factEvidenceAfter: linkedEvidencePage.endCursor,
                    })
                  : null,
            };
          }),
        }}
      />
      <PageControls
        label="Facts"
        resetHref={factAfter ? profilePageHref(personId, "facts") : null}
        nextHref={
          factPage?.hasNextPage && factPage.endCursor
            ? profilePageHref(personId, "facts", {
                factAfter: factPage.endCursor,
                catalogAfter,
              })
            : null
        }
        nextLabel="Next facts page"
      />
    </div>
  );
}
