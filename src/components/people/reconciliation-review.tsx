"use client";

import Link from "next/link";
import { useState } from "react";

import {
  MutationFeedback,
  transportMutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL, type GraphQLResult } from "@/graphql/client";
import {
  ReviewIdentityCandidateDocument,
  type IdentityCandidateState,
  type ReviewIdentityCandidateMutation,
} from "@/graphql/generated/graphql";

export type ReconciliationPerson = {
  id: string;
  displayName: string;
  preferredName?: string | null;
};

export type ReconciliationCandidate = {
  id: string;
  firstPersonId: string;
  secondPersonId: string;
  firstPerson: ReconciliationPerson | null;
  secondPerson: ReconciliationPerson | null;
  score: number;
  matchSignals: unknown;
  state: IdentityCandidateState;
  reviewReason?: string | null;
  reviewedAt?: string | null;
  version: number;
};

const reviewStates = [
  "REVIEWING",
  "ACCEPTED",
  "REJECTED",
  "CANCELLED",
] as const satisfies readonly IdentityCandidateState[];

type ReviewState = (typeof reviewStates)[number];

type ReviewStateDraft = {
  state: ReviewState;
  reason: string;
};

type CandidateFeedback = Record<string, MutationFeedbackView | null>;

function displayName(person: ReconciliationPerson | null, id: string) {
  return person?.displayName?.trim() || `Person ${id.slice(0, 8)}`;
}

function signalEntries(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value == null ? [] : [String(value)];
  }
  return Object.entries(value as Record<string, unknown>).map(
    ([key, signal]) => {
      if (typeof signal === "boolean")
        return `${key}: ${signal ? "yes" : "no"}`;
      if (typeof signal === "number" || typeof signal === "string")
        return `${key}: ${signal}`;
      return `${key}: ${JSON.stringify(signal)}`;
    },
  );
}

function scoreLabel(score: number) {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}% match`;
}

function initialDraft(candidate: ReconciliationCandidate): ReviewStateDraft {
  return {
    state: reviewStates.includes(candidate.state as ReviewState)
      ? (candidate.state as ReviewState)
      : "REVIEWING",
    reason: candidate.reviewReason ?? "",
  };
}

function candidateFromMutation(
  result: ReviewIdentityCandidateMutation,
  previous: ReconciliationCandidate,
): ReconciliationCandidate {
  const reviewed = result.reviewIdentityCandidate;
  return {
    ...previous,
    id: reviewed.id ?? previous.id,
    firstPersonId: reviewed.firstPersonId ?? previous.firstPersonId,
    secondPersonId: reviewed.secondPersonId ?? previous.secondPersonId,
    state: reviewed.state ?? previous.state,
    reviewReason: reviewed.reviewReason,
    reviewedAt: reviewed.reviewedAt,
    version: reviewed.version ?? previous.version,
  };
}

export function ReconciliationReview({
  candidates: initialCandidates,
  canReview,
}: {
  candidates: readonly ReconciliationCandidate[];
  canReview: boolean;
}) {
  const [candidates, setCandidates] = useState([...initialCandidates]);
  const [drafts, setDrafts] = useState<Record<string, ReviewStateDraft>>(() =>
    Object.fromEntries(
      initialCandidates.map((candidate) => [
        candidate.id,
        initialDraft(candidate),
      ]),
    ),
  );
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<CandidateFeedback>({});

  function updateDraft(id: string, patch: Partial<ReviewStateDraft>) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { state: "REVIEWING", reason: "" }),
        ...patch,
      },
    }));
  }

  async function review(candidate: ReconciliationCandidate) {
    if (!canReview || busy.has(candidate.id)) return;
    const draft = drafts[candidate.id] ?? initialDraft(candidate);
    const reason = draft.reason.trim().slice(0, 2048);
    const optimistic: ReconciliationCandidate = {
      ...candidate,
      state: draft.state,
      reviewReason: reason || null,
      version: candidate.version + 1,
    };
    setBusy((current) => new Set(current).add(candidate.id));
    setFeedback((current) => ({ ...current, [candidate.id]: null }));
    setCandidates((current) =>
      current.map((item) => (item.id === candidate.id ? optimistic : item)),
    );
    const restoreCandidate = () =>
      setCandidates((current) =>
        current.map((item) => (item.id === candidate.id ? candidate : item)),
      );
    let result: GraphQLResult<ReviewIdentityCandidateMutation>;
    try {
      result = await executeBrowserGraphQL(ReviewIdentityCandidateDocument, {
        input: {
          id: candidate.id,
          expectedVersion: candidate.version,
          state: draft.state,
          reason,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    } catch {
      restoreCandidate();
      setFeedback((current) => ({
        ...current,
        [candidate.id]: {
          code: "REQUEST_FAILED",
          fallback: "The reconciliation review could not be saved.",
          issues: [],
        },
      }));
      setBusy((current) => {
        const next = new Set(current);
        next.delete(candidate.id);
        return next;
      });
      return;
    }
    setBusy((current) => {
      const next = new Set(current);
      next.delete(candidate.id);
      return next;
    });
    if (!result.ok) {
      restoreCandidate();
      setFeedback((current) => ({
        ...current,
        [candidate.id]: transportMutationFeedback(
          result.errors,
          "The reconciliation review could not be saved.",
        ),
      }));
      return;
    }
    const next = candidateFromMutation(result.data, candidate);
    setCandidates((current) =>
      current.map((item) => (item.id === candidate.id ? next : item)),
    );
    setDrafts((current) => ({
      ...current,
      [candidate.id]: {
        state: next.state as ReviewState,
        reason: next.reviewReason ?? "",
      },
    }));
  }

  if (!candidates.length) {
    return (
      <section className="border-border bg-card rounded-2xl border border-dashed px-6 py-12 text-center">
        <h2 className="text-base font-semibold">No identity candidates</h2>
        <p className="text-muted-foreground mx-auto mt-2 max-w-lg text-sm">
          Potential duplicate identities will appear here when the workspace has
          candidates ready for review.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Identity candidates" className="space-y-5">
      {!canReview ? (
        <p className="border-border bg-muted/40 text-muted-foreground rounded-xl border px-4 py-3 text-sm">
          You can inspect candidate matches, but your workspace role cannot
          change their review state.
        </p>
      ) : null}
      {candidates.map((candidate) => {
        const draft = drafts[candidate.id] ?? initialDraft(candidate);
        const isBusy = busy.has(candidate.id);
        const signals = signalEntries(candidate.matchSignals);
        const firstName = displayName(
          candidate.firstPerson,
          candidate.firstPersonId,
        );
        const secondName = displayName(
          candidate.secondPerson,
          candidate.secondPersonId,
        );
        const candidateFeedback = feedback[candidate.id];
        return (
          <article
            key={candidate.id}
            className="border-border bg-card rounded-2xl border p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  <Link
                    className="hover:underline"
                    href={`/people/${candidate.firstPersonId}`}
                  >
                    {firstName}
                  </Link>
                  <span
                    className="text-muted-foreground mx-2"
                    aria-hidden="true"
                  >
                    ↔
                  </span>
                  <Link
                    className="hover:underline"
                    href={`/people/${candidate.secondPersonId}`}
                  >
                    {secondName}
                  </Link>
                </h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  Candidate {candidate.id}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge>{scoreLabel(candidate.score)}</Badge>
                <Badge variant="neutral">{candidate.state.toLowerCase()}</Badge>
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
              <div>
                <h3 className="text-sm font-semibold">Match signals</h3>
                {signals.length ? (
                  <ul className="text-muted-foreground mt-2 list-disc space-y-1 pl-5 text-sm">
                    {signals.map((signal) => (
                      <li key={signal}>{signal}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground mt-2 text-sm">
                    No match signals recorded.
                  </p>
                )}
                {candidate.reviewReason ? (
                  <p className="text-muted-foreground mt-4 text-sm">
                    Previous reason:{" "}
                    <span className="text-foreground">
                      {candidate.reviewReason}
                    </span>
                  </p>
                ) : null}
              </div>

              <div className="border-border bg-muted/20 rounded-xl border p-4">
                <Label htmlFor={`review-state-${candidate.id}`}>
                  Review decision
                </Label>
                <select
                  id={`review-state-${candidate.id}`}
                  value={draft.state}
                  disabled={!canReview || isBusy}
                  onChange={(event) =>
                    updateDraft(candidate.id, {
                      state: event.currentTarget.value as ReviewState,
                    })
                  }
                  className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
                >
                  {reviewStates.map((state) => (
                    <option key={state} value={state}>
                      {state[0] + state.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
                <Label
                  className="mt-3 block"
                  htmlFor={`review-reason-${candidate.id}`}
                >
                  Reason{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id={`review-reason-${candidate.id}`}
                  className="mt-2"
                  maxLength={2048}
                  value={draft.reason}
                  disabled={!canReview || isBusy}
                  onChange={(event) =>
                    updateDraft(candidate.id, {
                      reason: event.currentTarget.value,
                    })
                  }
                  placeholder="Why is this decision appropriate?"
                />
                <Button
                  type="button"
                  className="mt-3 w-full"
                  disabled={!canReview || isBusy}
                  onClick={() => void review(candidate)}
                >
                  {isBusy ? "Saving review…" : "Save review"}
                </Button>
                {candidateFeedback ? (
                  <div className="mt-3">
                    <MutationFeedback
                      feedback={candidateFeedback}
                      title="Review update failed"
                      onReload={() => window.location.reload()}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
