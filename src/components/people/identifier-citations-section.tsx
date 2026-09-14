import Link from "next/link";
import {
  PageControls,
  ResearchList,
} from "@/components/research/paginated-research-list";
import { PersonIdentifierCitationsDocument } from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";
import { cursorParam, type SearchState } from "@/lib/person-profile-params";
import { profilePageHref } from "@/lib/research-pagination";

export async function IdentifierCitationsSection({
  personId,
  search,
}: {
  personId: string;
  search: SearchState;
}) {
  const after = cursorParam(search, "identifierCitationAfter");
  const data = await executeServerGraphQL(PersonIdentifierCitationsDocument, {
    personId,
    first: 10,
    after,
  }).catch(() => null);
  if (!data?.personIdentifierCitations)
    return (
      <section
        aria-labelledby="identifier-citations-heading"
        className="space-y-3"
      >
        <h2 id="identifier-citations-heading" className="text-xl font-semibold">
          Identifier citations
        </h2>
        <p role="alert">Identifier citations could not be loaded.</p>
        <Link
          href={profilePageHref(personId, "evidence")}
          className="underline underline-offset-4"
        >
          Retry identifier citations
        </Link>
      </section>
    );
  const { nodes, pageInfo } = data.personIdentifierCitations;
  return (
    <div className="space-y-3">
      <ResearchList
        title="Identifier citations"
        empty="No current public identifier citations are visible on this page."
      >
        {(nodes ?? []).map((citation) => (
          <li
            key={citation.id}
            className="border-border bg-card space-y-2 rounded-xl border p-4"
          >
            <h3 className="font-semibold">
              {citation.sourceUrl ? (
                <a
                  href={citation.sourceUrl}
                  rel="noreferrer"
                  className="text-primary underline underline-offset-4"
                >
                  {citation.sourceTitle}
                </a>
              ) : (
                citation.sourceTitle
              )}
            </h3>
            <p className="text-sm">
              {citation.field} · version {citation.identifierVersion}
            </p>
            <p className="text-muted-foreground text-xs break-all">
              Identifier: {citation.identifierId}
            </p>
            <p className="text-sm">{citation.locator}</p>
            <blockquote className="border-primary border-l-2 pl-3 text-sm whitespace-pre-wrap">
              {citation.quote}
            </blockquote>
            <p className="text-muted-foreground text-sm">
              Confidence:{" "}
              {citation.confidence == null
                ? "Not rated"
                : `${Math.round(citation.confidence * 100)}%`}{" "}
              · Source reliability:{" "}
              {citation.sourceReliability == null
                ? "Not rated"
                : `${Math.round(citation.sourceReliability * 100)}%`}{" "}
              · Review: {citation.reviewState}
            </p>
            <p className="text-muted-foreground text-sm">
              Evidence role: {citation.role}
            </p>
          </li>
        ))}
      </ResearchList>
      <p className="text-muted-foreground text-sm">
        Only citations bound to a current public identifier version are shown. A
        citation records a source claim, not a verified fact.
      </p>
      <PageControls
        label="Identifier citations"
        nextLabel="Next identifier citations page"
        resetHref={after ? profilePageHref(personId, "evidence") : null}
        nextHref={
          pageInfo?.hasNextPage && pageInfo.endCursor
            ? profilePageHref(personId, "evidence", {
                identifierCitationAfter: pageInfo.endCursor,
              })
            : null
        }
      />
    </div>
  );
}
