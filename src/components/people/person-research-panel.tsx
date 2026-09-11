"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AiReviewQueue } from "@/components/ai/ai-review-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  AiReviewFieldsFragmentDoc,
  PendingAiSuggestionsDocument,
  PersonWebResearchDocument,
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
    </section>
  );
}
