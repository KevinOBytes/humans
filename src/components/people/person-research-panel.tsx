"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AiReviewQueue } from "@/components/ai/ai-review-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  AiReviewFieldsFragmentDoc,
  AcceptedAiResearchHistoryDocument,
  AcceptedAiResearchHistoryFieldsFragmentDoc,
  PendingAiSuggestionsDocument,
  PersonWebResearchDocument,
  type AcceptedAiResearchHistoryFieldsFragment,
  type AiReviewFieldsFragment,
} from "@/graphql/generated/graphql";

export type PersonResearchProjection = {
  id: string;
  displayName: string;
  preferredName?: string | null;
  sortName?: string | null;
  biography?: string | null;
  version: number;
};
export function PersonResearchPanel({
  person,
  canUpdate,
}: {
  person: PersonResearchProjection;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [caseId, setCaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<AiReviewFieldsFragment[]>([]);
  const [acceptedHistory, setAcceptedHistory] = useState<
    AcceptedAiResearchHistoryFieldsFragment[]
  >([]);
  const [acceptedHistoryState, setAcceptedHistoryState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [acceptedHistoryPage, setAcceptedHistoryPage] = useState<{
    endCursor: string | null;
    hasNextPage: boolean;
  }>({ endCursor: null, hasNextPage: false });
  const acceptedHistoryRequestGeneration = useRef(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  async function loadQueue() {
    const result = await executeBrowserGraphQL(PendingAiSuggestionsDocument, {
      personId: person.id,
      purpose: purpose.trim().toLowerCase(),
      caseId: caseId || null,
    });
    if (!result.ok) {
      setSuggestions([]);
      setFeedback(
        "The review queue could not be loaded. Check purpose coverage and case membership.",
      );
      return;
    }
    setSuggestions(
      result.data.pendingAiSuggestions.map((s) =>
        readFragment(AiReviewFieldsFragmentDoc, s),
      ),
    );
  }
  async function loadAcceptedHistory(after: string | null = null) {
    const requestGeneration = ++acceptedHistoryRequestGeneration.current;
    setAcceptedHistoryState("loading");
    try {
      const result = await executeBrowserGraphQL(
        AcceptedAiResearchHistoryDocument,
        {
          personId: person.id,
          purpose: purpose.trim().toLowerCase(),
          caseId: caseId || null,
          first: 10,
          after,
        },
      );
      if (requestGeneration !== acceptedHistoryRequestGeneration.current)
        return;
      if (!result.ok) {
        if (!after) setAcceptedHistory([]);
        setAcceptedHistoryState("error");
        return;
      }
      const nodes = result.data.acceptedAiResearchHistory.nodes.map((node) =>
        readFragment(AcceptedAiResearchHistoryFieldsFragmentDoc, node),
      );
      setAcceptedHistory((current) => (after ? [...current, ...nodes] : nodes));
      setAcceptedHistoryPage(result.data.acceptedAiResearchHistory.pageInfo);
      setAcceptedHistoryState("loaded");
    } catch {
      if (requestGeneration !== acceptedHistoryRequestGeneration.current)
        return;
      if (!after) setAcceptedHistory([]);
      setAcceptedHistoryState("error");
    }
  }
  function clearAcceptedHistory() {
    acceptedHistoryRequestGeneration.current += 1;
    setAcceptedHistory([]);
    setAcceptedHistoryPage({ endCursor: null, hasNextPage: false });
    setAcceptedHistoryState("idle");
  }
  async function research() {
    setBusy(true);
    setFeedback(null);
    setRunId(null);
    setSuggestions([]);
    try {
      const result = await executeBrowserGraphQL(PersonWebResearchDocument, {
        personId: person.id,
        consent: true,
        purpose: purpose.trim().toLowerCase(),
        caseId: caseId || null,
      });
      if (!result.ok) {
        setFeedback(
          "Web research could not be completed. Check current purpose coverage, permissions, and provider configuration.",
        );
        return;
      }
      setRunId(result.data.personWebResearch.runId);
      await loadQueue();
    } catch {
      setFeedback("Web research could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    setFeedback(null);
    try {
      await loadQueue();
    } catch {
      setFeedback("The review queue could not be loaded.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="border-border bg-muted/30 mt-6 rounded-2xl border p-5">
      <h2 className="text-lg font-semibold">Web research</h2>
      <p className="text-muted-foreground mt-2 text-sm leading-6">
        This sends the confirmed public name—and, for public records, the
        biography—to configured web search and AI providers. It never sends
        contacts, addresses, relationships, notes, or identifiers. Results are
        drafts until you review their evidence and explicitly apply them. Active
        purpose coverage is required.
      </p>
      <Label className="mt-4 block" htmlFor="research-purpose">
        Governed purpose
      </Label>
      <Input
        id="research-purpose"
        value={purpose}
        onChange={(e) => {
          setPurpose(e.target.value);
          setSuggestions([]);
          clearAcceptedHistory();
        }}
        maxLength={200}
        disabled={busy}
      />
      <Label className="mt-3 block" htmlFor="research-case">
        Case ID (optional)
      </Label>
      <Input
        id="research-case"
        value={caseId}
        onChange={(e) => {
          setCaseId(e.target.value);
          setSuggestions([]);
          clearAcceptedHistory();
        }}
        disabled={busy}
      />
      <Label
        className="mt-4 flex items-start gap-3"
        htmlFor="person-research-consent"
      >
        <input
          id="person-research-consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 size-4"
        />
        <span>I understand and want to search public web sources</span>
      </Label>
      <div className="mt-4 flex gap-2">
        <Button
          disabled={!consent || !purpose.trim() || busy}
          onClick={() => void research()}
        >
          {busy ? "Researching…" : "Research this person"}
        </Button>
        <Button
          variant="outline"
          disabled={!purpose.trim() || busy}
          onClick={() => void reload()}
        >
          Load pending reviews
        </Button>
      </div>
      {feedback && (
        <p role="alert" className="mt-4">
          {feedback}
        </p>
      )}
      {runId && (
        <p role="status" className="mt-4 text-xs">
          Provenance recorded as research run {runId}. The original proposal and
          sources remain unchanged after review.
        </p>
      )}
      {!canUpdate && (
        <p className="mt-4 text-sm">
          You can review suggestions, but you do not have permission to apply
          them.
        </p>
      )}
      {suggestions.length > 0 && (
        <AiReviewQueue
          suggestions={suggestions}
          canReview={canUpdate}
          onChange={() => {
            void reload();
            router.refresh();
          }}
        />
      )}
      <div className="border-border mt-6 border-t pt-5">
        <h3 className="text-base font-semibold">Accepted research history</h3>
        <p className="text-muted-foreground mt-1 text-sm leading-6">
          Human-approved AI suggestions retain their original run, reviewer,
          evidence, confidence, and uncertainty. This history is read-only.
        </p>
        <Button
          className="mt-3"
          variant="outline"
          disabled={!purpose.trim() || acceptedHistoryState === "loading"}
          onClick={() => void loadAcceptedHistory()}
        >
          {acceptedHistoryState === "loading"
            ? "Loading accepted history…"
            : "Load accepted history"}
        </Button>
        {!purpose.trim() && acceptedHistoryState === "idle" && (
          <p className="text-muted-foreground mt-3 text-sm">
            Enter a governed purpose to load accepted history.
          </p>
        )}
        {acceptedHistoryState === "error" && (
          <p role="alert" className="mt-3 text-sm">
            Accepted research history could not be loaded. Check current purpose
            coverage and access.
          </p>
        )}
        {acceptedHistoryState === "loaded" && acceptedHistory.length === 0 && (
          <p className="text-muted-foreground mt-3 text-sm">
            No accepted AI research exists for this person and purpose.
          </p>
        )}
        {acceptedHistory.length > 0 && (
          <ol className="mt-4 space-y-3">
            {acceptedHistory.map((item) => (
              <li
                key={item.id}
                className="border-border bg-background rounded-xl border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{item.fieldKey}</p>
                  <p className="text-muted-foreground text-xs">
                    {item.provider} / {item.model}
                  </p>
                </div>
                <dl className="text-muted-foreground mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">Confidence</dt>
                    <dd>{Math.round(item.confidence * 100)}%</dd>
                  </div>
                  <div>
                    <dt className="font-medium">Reviewed</dt>
                    <dd>
                      <time dateTime={item.reviewedAt}>
                        {new Date(item.reviewedAt).toLocaleString()}
                      </time>
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-medium">Uncertainty</dt>
                    <dd>{item.uncertainty}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-medium">Reviewer</dt>
                    <dd className="break-all">{item.reviewerPrincipalId}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-medium">Research run</dt>
                    <dd className="break-all">{item.researchRunId}</dd>
                  </div>
                  {item.decisionReason && (
                    <div className="sm:col-span-2">
                      <dt className="font-medium">Decision reason</dt>
                      <dd>{item.decisionReason}</dd>
                    </div>
                  )}
                </dl>
                <div className="mt-3 text-xs">
                  <p className="font-medium">Accepted resource</p>
                  {item.acceptedResource.redacted ? (
                    <p className="text-muted-foreground mt-1">
                      Accepted resource details are redacted for your access.
                    </p>
                  ) : (
                    <p className="text-muted-foreground mt-1 break-all">
                      {item.acceptedResource.kind} {item.acceptedResource.id}
                    </p>
                  )}
                </div>
                <div className="mt-3 text-xs">
                  <p className="font-medium">Accepted evidence</p>
                  <ul className="mt-1 space-y-2">
                    {item.evidenceReferences.map((reference, index) => (
                      <li key={`${item.id}-evidence-${index}`}>
                        {reference.redacted ? (
                          <span className="text-muted-foreground">
                            Evidence details are redacted for your access.
                          </span>
                        ) : reference.kind === "web" && reference.url ? (
                          <span>
                            <a
                              className="underline underline-offset-2"
                              href={reference.url}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {reference.url}
                            </a>
                            {reference.locator ? ` — ${reference.locator}` : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Evidence {reference.evidenceId}
                            {reference.locator ? ` — ${reference.locator}` : ""}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        )}
        {acceptedHistoryPage.hasNextPage && acceptedHistoryPage.endCursor && (
          <Button
            className="mt-3"
            variant="outline"
            disabled={acceptedHistoryState === "loading"}
            onClick={() =>
              void loadAcceptedHistory(acceptedHistoryPage.endCursor)
            }
          >
            Load more accepted history
          </Button>
        )}
      </div>
    </section>
  );
}
