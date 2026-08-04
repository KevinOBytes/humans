import Link from "next/link";
import type { ReactNode } from "react";

import type { PersonProfileView } from "@/components/research/types";
import { Badge } from "@/components/ui/badge";

const stateLabels: Record<string, string> = {
  ASSERTED: "Asserted",
  DISPROVEN: "Disproven",
  DISPUTED: "Disputed",
  SUPERSEDED: "Superseded",
};

function stateVariant(state: string) {
  const normalized = state.toLowerCase();
  if (
    normalized === "asserted" ||
    normalized === "disputed" ||
    normalized === "disproven" ||
    normalized === "superseded"
  ) {
    return normalized;
  }
  return "neutral";
}

export function PersonProfile({
  actions,
  person,
  showHeader = true,
}: {
  actions?: Readonly<Record<string, ReactNode>>;
  person: PersonProfileView;
  showHeader?: boolean;
}) {
  return (
    <section aria-labelledby="person-profile-title" className="space-y-8">
      {showHeader ? (
        <header className="border-border bg-card rounded-2xl border p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.16em] uppercase">
                Person record
              </p>
              <h2
                id="person-profile-title"
                className="mt-2 text-2xl font-semibold tracking-tight"
              >
                {person.displayName}
              </h2>
              {person.preferredName ? (
                <p className="text-muted-foreground mt-1 text-sm">
                  Preferred name: {person.preferredName}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge>{person.status.toLowerCase()}</Badge>
              <Badge>{person.sensitivity.toLowerCase()}</Badge>
            </div>
          </div>
          {person.biography ? (
            <p className="text-muted-foreground mt-5 max-w-3xl text-sm leading-6">
              {person.biography}
            </p>
          ) : null}
        </header>
      ) : null}

      <section aria-labelledby="claims-heading">
        <div className="mb-4">
          <h3 id="claims-heading" className="text-lg font-semibold">
            Claims
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Competing claims remain independent; presentation selection does not
            erase uncertainty.
          </p>
        </div>
        {person.facts.length === 0 ? (
          <div className="border-border bg-card text-muted-foreground rounded-2xl border border-dashed p-8 text-center text-sm">
            No facts have been recorded for this person.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {person.facts.map((fact, index) => (
              <article
                key={fact.id}
                aria-label={`${fact.label} claim`}
                className="border-border bg-card rounded-2xl border p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-muted-foreground text-xs font-medium">
                      {fact.namespace}.{fact.fieldKey}
                    </p>
                    <h4 className="mt-1 font-semibold">{fact.label}</h4>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Badge variant={stateVariant(fact.state)}>
                      {stateLabels[fact.state] ?? fact.state}
                    </Badge>
                    {fact.selected ? (
                      <Badge variant="selected">
                        Selected for presentation
                      </Badge>
                    ) : fact.selectionVerified === false ? (
                      <Badge>Selection not verified</Badge>
                    ) : null}
                  </div>
                </div>
                <p className="mt-5 font-mono text-base leading-7 break-words">
                  {fact.value}
                </p>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Confidence</dt>
                    <dd className="mt-1 font-semibold">
                      {fact.confidence === null || fact.confidence === undefined
                        ? "Not rated"
                        : `${Math.round(fact.confidence * 100)}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      Temporal precision
                    </dt>
                    <dd className="mt-1 font-semibold">
                      {fact.temporalLabel ?? "Unspecified"}
                    </dd>
                  </div>
                </dl>
                {actions?.[fact.id]}

                {fact.revisions.length > 0 ? (
                  <section
                    aria-label={`Revision provenance for claim ${index + 1}`}
                    className="border-border mt-5 border-t pt-4"
                  >
                    <h5 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                      Revision provenance
                    </h5>
                    <ul className="mt-3 space-y-2 text-sm">
                      {fact.revisions.map((revision) => (
                        <li key={revision.id}>
                          <span className="font-medium">
                            Revision {revision.revision}
                          </span>
                          {revision.changeReason ? (
                            <>
                              {" — "}
                              <span>{revision.changeReason}</span>
                            </>
                          ) : null}
                          {revision.actorLabel ? (
                            <span className="text-muted-foreground">
                              {" "}
                              by {revision.actorLabel}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {fact.revisionResetHref || fact.revisionNextHref ? (
                      <div className="mt-3 flex flex-wrap gap-3 text-sm">
                        {fact.revisionResetHref ? (
                          <Link
                            href={fact.revisionResetHref}
                            className="text-primary font-semibold underline-offset-4 hover:underline"
                          >
                            First revisions page
                          </Link>
                        ) : null}
                        {fact.revisionNextHref ? (
                          <Link
                            href={fact.revisionNextHref}
                            className="text-primary font-semibold underline-offset-4 hover:underline"
                          >
                            More revisions for {fact.label}
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                ) : fact.revisionResetHref || fact.revisionNextHref ? (
                  <div className="border-border mt-5 border-t pt-4">
                    <Link
                      href={fact.revisionNextHref ?? fact.revisionResetHref!}
                      className="text-primary text-sm font-semibold underline-offset-4 hover:underline"
                    >
                      Continue revision history
                    </Link>
                  </div>
                ) : null}

                {fact.evidence.length > 0 ? (
                  <section
                    aria-label={`Linked evidence for claim ${index + 1}`}
                    className="border-border mt-5 border-t pt-4"
                  >
                    <h5 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                      Linked evidence
                    </h5>
                    <ul className="mt-3 space-y-3">
                      {fact.evidence.map((evidence) => (
                        <li
                          key={evidence.id}
                          className="bg-muted rounded-xl p-3 text-sm"
                        >
                          <p className="font-semibold">{evidence.title}</p>
                          {evidence.locator ? (
                            <p className="text-muted-foreground mt-1">
                              {evidence.locator}
                            </p>
                          ) : null}
                          {evidence.excerpt ? (
                            <blockquote className="border-primary mt-2 border-l-2 pl-3">
                              {evidence.excerpt}
                            </blockquote>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {fact.evidenceResetHref || fact.evidenceNextHref ? (
                      <div className="mt-3 flex flex-wrap gap-3 text-sm">
                        {fact.evidenceResetHref ? (
                          <Link
                            href={fact.evidenceResetHref}
                            className="text-primary font-semibold underline-offset-4 hover:underline"
                          >
                            First evidence page
                          </Link>
                        ) : null}
                        {fact.evidenceNextHref ? (
                          <Link
                            href={fact.evidenceNextHref}
                            className="text-primary font-semibold underline-offset-4 hover:underline"
                          >
                            More evidence for {fact.label}
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                ) : fact.evidenceResetHref || fact.evidenceNextHref ? (
                  <div className="border-border mt-5 border-t pt-4">
                    <Link
                      href={fact.evidenceNextHref ?? fact.evidenceResetHref!}
                      className="text-primary text-sm font-semibold underline-offset-4 hover:underline"
                    >
                      Continue linked evidence
                    </Link>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
