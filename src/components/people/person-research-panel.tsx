"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  MutationFeedback,
  payloadMutationFeedback,
  transportMutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL, type GraphQLResult } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PersonSummaryFragmentDoc,
  PersonWebResearchDocument,
  UpdatePersonDocument,
  type PersonWebResearchMutation,
  type UpdatePersonMutation,
  type UpdatePersonInput,
} from "@/graphql/generated/graphql";

const fields = [
  "displayName",
  "preferredName",
  "sortName",
  "biography",
] as const;
type ResearchField = (typeof fields)[number];
type DraftSuggestion = {
  field: ResearchField;
  value: string;
  sourceUrls: string[];
  accepted: boolean;
};
type ResearchSource = { title: string; url: string; snippet: string };

const labels: Record<ResearchField, string> = {
  displayName: "Display name",
  preferredName: "Preferred name",
  sortName: "Sort name",
  biography: "Biography",
};

function isResearchField(value: string): value is ResearchField {
  return fields.some((field) => field === value);
}

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
  const [researching, setResearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [suggestions, setSuggestions] = useState<DraftSuggestion[]>([]);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState(person.version);

  async function research() {
    setResearching(true);
    setFeedback(null);
    setSaved(false);
    let result: GraphQLResult<PersonWebResearchMutation>;
    try {
      result = await executeBrowserGraphQL(PersonWebResearchDocument, {
        personId: person.id,
        consent: true,
      });
    } catch {
      setResearching(false);
      setFeedback({
        code: "REQUEST_FAILED",
        fallback: "Web research could not be completed.",
        issues: [],
      });
      return;
    }
    setResearching(false);
    if (!result.ok) {
      setFeedback(
        transportMutationFeedback(
          result.errors,
          "Web research could not be completed.",
        ),
      );
      return;
    }
    const researchResult = result.data.personWebResearch;
    const drafts: DraftSuggestion[] = [];
    for (const suggestion of researchResult.suggestions) {
      if (!isResearchField(suggestion.field)) continue;
      drafts.push({ ...suggestion, field: suggestion.field, accepted: false });
    }
    setSuggestions(drafts);
    setSources(researchResult.sources);
    setProvider(`${researchResult.provider} · ${researchResult.model}`);
  }

  async function applySelected() {
    const selected = suggestions.filter((suggestion) => suggestion.accepted);
    if (!selected.length || !canUpdate) return;
    const input: UpdatePersonInput = {
      id: person.id,
      expectedVersion: version,
    };
    for (const suggestion of selected)
      input[suggestion.field] = suggestion.value;

    setApplying(true);
    setFeedback(null);
    setSaved(false);
    let result: GraphQLResult<UpdatePersonMutation>;
    try {
      result = await executeBrowserGraphQL(UpdatePersonDocument, { input });
    } catch {
      setApplying(false);
      setFeedback({
        code: "REQUEST_FAILED",
        fallback: "The selected research fields could not be applied.",
        issues: [],
      });
      return;
    }
    setApplying(false);
    if (!result.ok) {
      setFeedback(
        transportMutationFeedback(
          result.errors,
          "The selected research fields could not be applied.",
        ),
      );
      return;
    }
    const payload = result.data.updatePerson;
    const updated = readFragment(PersonSummaryFragmentDoc, payload.person);
    if (!updated) {
      setFeedback(
        payloadMutationFeedback({
          code: payload.code,
          currentVersion: payload.currentVersion,
          fallback: "The selected research fields could not be applied.",
          issues: payload.issues,
          requestId: result.requestId,
        }),
      );
      return;
    }
    setVersion(updated.version);
    setSaved(true);
    router.refresh();
  }

  const acceptedCount = suggestions.filter(
    (suggestion) => suggestion.accepted,
  ).length;
  const allAccepted =
    suggestions.length > 0 && acceptedCount === suggestions.length;

  return (
    <section className="border-border bg-muted/30 mt-6 rounded-2xl border p-5">
      <h2 className="text-lg font-semibold">Web research</h2>
      <p className="text-muted-foreground mt-2 text-sm leading-6">
        This sends the confirmed public name—and, for public records, the
        biography—to configured web search and AI providers. It never sends
        contacts, addresses, relationships, notes, or identifiers. Results are
        drafts until you select fields and apply them.
      </p>
      <Label
        className="mt-4 flex items-start gap-3"
        htmlFor="person-research-consent"
      >
        <input
          id="person-research-consent"
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.currentTarget.checked)}
          className="mt-1 size-4"
        />
        <span>I understand and want to search public web sources</span>
      </Label>
      <Button
        type="button"
        className="mt-4"
        disabled={!consent || researching}
        onClick={() => void research()}
      >
        {researching ? "Researching…" : "Research this person"}
      </Button>

      {feedback ? (
        <div className="mt-4">
          <MutationFeedback
            feedback={feedback}
            title="Research update failed"
            onReload={
              feedback.code === "CONFLICT" ? () => router.refresh() : undefined
            }
          />
        </div>
      ) : null}

      {suggestions.length ? (
        <div className="mt-6 space-y-5">
          <div>
            <h3 className="font-semibold">Review suggestions</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {provider}. AI filled these drafts from the cited sources. Edit
              anything that needs correction, then accept only the fields you
              want to save.
            </p>
          </div>
          <Label
            className="border-border bg-card flex items-center gap-3 rounded-xl border p-3"
            htmlFor="person-research-accept-all"
          >
            <input
              id="person-research-accept-all"
              type="checkbox"
              checked={allAccepted}
              onChange={(event) => {
                const accepted = event.currentTarget.checked;
                setSuggestions((current) =>
                  current.map((suggestion) => ({ ...suggestion, accepted })),
                );
              }}
              aria-label="Accept all suggested fields"
              className="size-4"
            />
            <span>
              <span className="block">Accept all suggested fields</span>
              <span className="text-muted-foreground mt-0.5 block text-xs font-normal">
                {acceptedCount} of {suggestions.length} accepted
              </span>
            </span>
          </Label>
          {suggestions.map((suggestion, index) => {
            const label = labels[suggestion.field];
            const inputId = `research-${suggestion.field}-${index}`;
            return (
              <div
                key={inputId}
                className="border-border bg-card rounded-xl border p-4"
              >
                <Label
                  className="flex items-center gap-3"
                  htmlFor={`${inputId}-accept`}
                >
                  <input
                    id={`${inputId}-accept`}
                    type="checkbox"
                    checked={suggestion.accepted}
                    onChange={(event) => {
                      const accepted = event.currentTarget.checked;
                      setSuggestions((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, accepted } : item,
                        ),
                      );
                    }}
                    aria-label={`Apply ${label}`}
                    className="size-4"
                  />
                  Apply {label}
                </Label>
                {suggestion.accepted ? (
                  <span className="text-primary mt-2 block text-xs font-semibold">
                    ✓ Accepted for saving
                  </span>
                ) : null}
                <Label className="mt-3 block" htmlFor={inputId}>
                  {label} suggestion
                </Label>
                {suggestion.field === "biography" ? (
                  <textarea
                    id={inputId}
                    value={suggestion.value}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSuggestions((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, value } : item,
                        ),
                      );
                    }}
                    className="border-input bg-background mt-2 min-h-28 w-full rounded-xl border p-3 text-sm"
                  />
                ) : (
                  <Input
                    id={inputId}
                    className="mt-2"
                    value={suggestion.value}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSuggestions((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, value } : item,
                        ),
                      );
                    }}
                  />
                )}
                <ul className="text-muted-foreground mt-3 space-y-1 text-xs">
                  {suggestion.sourceUrls.map((url) => (
                    <li key={url}>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {sources.length ? (
            <div>
              <h3 className="text-sm font-semibold">Sources</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {sources.map((source) => (
                  <li key={source.url}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary font-medium underline"
                    >
                      {source.title}
                    </a>
                    {source.snippet ? (
                      <p className="text-muted-foreground mt-1">
                        {source.snippet}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!canUpdate ? (
            <p className="text-muted-foreground text-sm">
              You can review suggestions, but you do not have permission to
              apply them.
            </p>
          ) : null}
          <Button
            type="button"
            disabled={!canUpdate || acceptedCount === 0 || applying}
            onClick={() => void applySelected()}
          >
            {applying ? "Applying…" : "Apply selected fields"}
          </Button>
          {saved ? (
            <p role="status" className="text-sm font-medium">
              Selected fields applied.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
