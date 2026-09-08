import { getAppContext } from "@/app/(app)/app-session";
import { ReconciliationReview } from "@/components/people/reconciliation-review";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  IdentityCandidatesDocument,
  PersonSummaryFragmentDoc,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;
  if (!context.viewer.permissions.includes("person:read")) {
    return (
      <section className="border-border bg-card rounded-2xl border p-6">
        <h1 className="text-2xl font-semibold">Reconciliation</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          You do not have permission to view identity candidates in this
          workspace.
        </p>
      </section>
    );
  }

  const data = await executeServerGraphQL(IdentityCandidatesDocument, {
    limit: 100,
  });
  const candidates = (data.identityCandidates ?? [])
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(
        candidate.id &&
        candidate.firstPersonId &&
        candidate.secondPersonId &&
        candidate.score != null &&
        candidate.state &&
        candidate.version != null,
      ),
    )
    .map((candidate) => {
      const id = candidate.id!;
      const firstPersonId = candidate.firstPersonId!;
      const secondPersonId = candidate.secondPersonId!;
      const score = candidate.score!;
      const state = candidate.state!;
      const version = candidate.version!;
      const firstPerson = candidate.firstPerson
        ? readFragment(PersonSummaryFragmentDoc, candidate.firstPerson)
        : null;
      const secondPerson = candidate.secondPerson
        ? readFragment(PersonSummaryFragmentDoc, candidate.secondPerson)
        : null;
      return {
        id,
        firstPersonId,
        secondPersonId,
        firstPerson: firstPerson
          ? {
              id: firstPerson.id,
              displayName: firstPerson.displayName,
              preferredName: firstPerson.preferredName,
              status: firstPerson.status,
              version: firstPerson.version,
            }
          : null,
        secondPerson: secondPerson
          ? {
              id: secondPerson.id,
              displayName: secondPerson.displayName,
              preferredName: secondPerson.preferredName,
              status: secondPerson.status,
              version: secondPerson.version,
            }
          : null,
        score,
        matchSignals: candidate.matchSignals,
        state,
        reviewReason: candidate.reviewReason,
        reviewedAt: candidate.reviewedAt,
        version,
      };
    });

  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          Reconciliation
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
          Review possible duplicate identities before taking any merge action.
          Candidate state changes are workspace-scoped, version-checked, and
          recorded with an audit reason.
        </p>
      </header>
      <ReconciliationReview
        candidates={candidates}
        canReview={context.viewer.permissions.includes("person:merge")}
      />
    </div>
  );
}
