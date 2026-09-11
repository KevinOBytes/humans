"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  AcceptAiSuggestionDocument,
  RejectAiSuggestionDocument,
  DeferAiSuggestionDocument,
  ReviewAiBatchDocument,
  type AiReviewFieldsFragment,
} from "@/graphql/generated/graphql";
import { z } from "zod";

// Validate only the public display projection here; domain validation stays server-side.
const aiProposedValueSchema = z.object({
  kind: z.literal("profile"),
  value: z.string(),
});
const aiEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("web"),
    url: z.url().refine((url) => new URL(url).protocol === "https:"),
    locator: z.string(),
    quote: z.string(),
  }),
  z.object({
    kind: z.literal("evidence"),
    evidenceId: z.uuid(),
    locator: z.string(),
    quote: z.string(),
  }),
]);

type Projection = Omit<AiReviewFieldsFragment, "reviewedBy" | "reviewedAt">;
export function AiReviewQueue({
  suggestions,
  canReview,
  onChange,
}: {
  suggestions: Projection[];
  canReview: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  async function decide(
    row: Projection,
    decision: "accept" | "reject" | "defer",
  ) {
    setBusy(true);
    setError(null);
    try {
      const input = { id: row.id, expectedVersion: row.version };
      const result =
        decision === "accept"
          ? await executeBrowserGraphQL(AcceptAiSuggestionDocument, {
              input: { ...input, explicitConfirmed: true },
            })
          : decision === "reject"
            ? await executeBrowserGraphQL(RejectAiSuggestionDocument, {
                input: { ...input, reason: reasons[row.id] ?? "" },
              })
            : await executeBrowserGraphQL(DeferAiSuggestionDocument, { input });
      if (!result.ok)
        setError(
          "The review could not be saved. Refresh to check current access and status.",
        );
      else onChange();
    } catch {
      setError("The review could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function batch() {
    if (!approved || !selected.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeBrowserGraphQL(ReviewAiBatchDocument, {
        input: {
          approved: true,
          suggestions: suggestions
            .filter((s) => selected.includes(s.id))
            .map((s) => ({ id: s.id, expectedVersion: s.version })),
        },
      });
      if (!result.ok)
        setError(
          "The batch was not applied. Check each suggestion and current access.",
        );
      else {
        setSelected([]);
        setApproved(false);
        onChange();
      }
    } catch {
      setError("The batch was not applied.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="AI review queue" className="mt-6 space-y-4">
      <h3 className="font-semibold">Review suggestions</h3>
      <p className="text-muted-foreground text-sm">
        AI proposals are not verified facts. Review each source and uncertainty.
        No adverse decision is made automatically; accepted relationships remain
        inferred until independent evidence review.
      </p>
      {error && <p role="alert">{error}</p>}
      {suggestions.map((row) => {
        const parsed = aiProposedValueSchema.safeParse(row.proposedValue);
        const references = aiEvidenceReferenceSchema
          .array()
          .safeParse(row.evidenceReferences);
        const pending = ["pending", "deferred"].includes(row.status);
        return (
          <article key={row.id} className="border-border rounded-xl border p-4">
            <h4 className="font-semibold">
              {row.fieldKey} · {row.status}
            </h4>
            <p className="text-muted-foreground text-xs">
              {row.provider} · {row.model} · Confidence:{" "}
              {Math.round(row.confidence * 100)}%
            </p>
            <p className="mt-2 text-sm">Current value</p>
            <p>
              {row.currentValue ??
                "No profile value (new fact or relationship)"}
            </p>
            <p className="mt-2 text-sm">Proposed value</p>
            <p>
              {parsed.success && parsed.data.kind === "profile"
                ? parsed.data.value
                : JSON.stringify(row.proposedValue)}
            </p>
            <p className="mt-2 text-sm">{row.uncertainty}</p>
            <p className="text-muted-foreground text-xs">
              Research run {row.researchRunId} · Policy{" "}
              {row.promptPolicyVersion}
            </p>
            {references.success && (
              <ul className="mt-3 text-sm">
                {references.data.map((ref, index) => (
                  <li key={index}>
                    <blockquote>{ref.quote}</blockquote>
                    <p>{ref.locator}</p>
                    {ref.kind === "web" ? (
                      <a
                        className="underline"
                        href={ref.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {ref.url}
                      </a>
                    ) : (
                      <span>Evidence {ref.evidenceId}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Label className="mt-3 block" htmlFor={`reason-${row.id}`}>
              Reason for rejecting {row.fieldKey}
            </Label>
            <input
              id={`reason-${row.id}`}
              className="border-input mt-1 w-full rounded border p-2"
              value={reasons[row.id] ?? ""}
              onChange={(e) =>
                setReasons({ ...reasons, [row.id]: e.target.value })
              }
              maxLength={2000}
              disabled={!canReview || busy || !pending}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={!canReview || busy || !pending}
                onClick={() => void decide(row, "accept")}
              >
                Accept {row.fieldKey}
              </Button>
              <Button
                variant="outline"
                disabled={
                  !canReview || busy || !pending || !reasons[row.id]?.trim()
                }
                onClick={() => void decide(row, "reject")}
              >
                Reject {row.fieldKey}
              </Button>
              <Button
                variant="outline"
                disabled={!canReview || busy || !pending}
                onClick={() => void decide(row, "defer")}
              >
                Defer {row.fieldKey}
              </Button>
            </div>
            <Label className="mt-3 flex gap-2">
              <input
                type="checkbox"
                checked={selected.includes(row.id)}
                disabled={!canReview || busy || !pending}
                onChange={(e) => {
                  setSelected(
                    e.target.checked
                      ? [...selected, row.id]
                      : selected.filter((id) => id !== row.id),
                  );
                  setApproved(false);
                }}
              />
              Select {row.fieldKey} for batch review
            </Label>
          </article>
        );
      })}
      {suggestions.length > 1 && (
        <div>
          <Label className="flex gap-2">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              disabled={!canReview || busy || !selected.length}
            />
            I reviewed the evidence and explicitly approve the selected fields
          </Label>
          <Button
            className="mt-2"
            disabled={!canReview || busy || !approved || !selected.length}
            onClick={() => void batch()}
          >
            Apply selected fields
          </Button>
        </div>
      )}
    </section>
  );
}
