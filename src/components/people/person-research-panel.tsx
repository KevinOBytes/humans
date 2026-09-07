"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { executeBrowserGraphQL } from "@/graphql/client";
import {
  PersonWebResearchDocument,
  UpdatePersonDocument,
  type PersonWebResearchMutation,
  type UpdatePersonMutationVariables,
} from "@/graphql/generated/graphql";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ResearchPerson = {
  biography?: string | null;
  displayName: string;
  id: string;
  preferredName?: string | null;
  sortName?: string | null;
  version: number;
};

type Suggestion =
  PersonWebResearchMutation["personWebResearch"]["suggestions"][number];

const fieldLabels: Record<string, string> = {
  biography: "Biography",
  displayName: "Display name",
  preferredName: "Preferred name",
  sortName: "Sort name",
};

function errorMessage(result: {
  errors?: readonly { code?: string; message?: string }[];
  requestId?: string;
}) {
  const first = result.errors?.[0];
  return (
    [first?.code, first?.message, result.requestId]
      .filter(Boolean)
      .join(" · ") || "The request could not be completed."
  );
}

export function PersonResearchPanel({
  canUpdate,
  person,
}: {
  canUpdate: boolean;
  person: ResearchPerson;
}) {
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [disclosure, setDisclosure] = useState<{
    model: string;
    provider: string;
  } | null>(null);
  const [sources, setSources] = useState<
    PersonWebResearchMutation["personWebResearch"]["sources"]
  >([]);
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const selectedSuggestions = useMemo(
    () => suggestions.filter((suggestion) => selected.has(suggestion.field)),
    [selected, suggestions],
  );

  async function research() {
    if (!consent || pending) return;
    setPending(true);
    setMessage(null);
    setSearched(false);
    setDisclosure(null);
    setSources([]);
    setSuggestions([]);
    setSelected(new Set());
    try {
      const result = await executeBrowserGraphQL(PersonWebResearchDocument, {
        personId: person.id,
        consent: true,
      });
      if (!result.ok) {
        setMessage(errorMessage(result));
        return;
      }
      const payload = result.data.personWebResearch;
      const next = payload.suggestions;
      setSearched(true);
      setDisclosure({ model: payload.model, provider: payload.provider });
      setSources(payload.sources);
      setSuggestions(next);
      setDrafts(
        Object.fromEntries(
          next.map((suggestion) => [suggestion.field, suggestion.value]),
        ),
      );
    } catch {
      setMessage("The research request failed. Your record was not changed.");
    } finally {
      setPending(false);
    }
  }

  async function applySelected() {
    if (applying || selectedSuggestions.length === 0) return;
    setApplying(true);
    setMessage(null);
    const input: UpdatePersonMutationVariables["input"] = {
      id: person.id,
      expectedVersion: person.version,
    };
    for (const suggestion of selectedSuggestions) {
      const value = drafts[suggestion.field]?.trim();
      if (!value) continue;
      if (suggestion.field === "displayName") input.displayName = value;
      if (suggestion.field === "preferredName") input.preferredName = value;
      if (suggestion.field === "sortName") input.sortName = value;
      if (suggestion.field === "biography") input.biography = value;
    }
    if (
      !input.displayName &&
      !input.preferredName &&
      !input.sortName &&
      !input.biography
    ) {
      setApplying(false);
      return;
    }
    try {
      const result = await executeBrowserGraphQL(UpdatePersonDocument, {
        input,
      });
      if (!result.ok) {
        setMessage(errorMessage(result));
        return;
      }
      const payload = result.data.updatePerson;
      if (!payload.person) {
        setMessage(
          [
            payload.code,
            payload.currentVersion &&
              `current version ${payload.currentVersion}`,
          ]
            .filter(Boolean)
            .join(" · ") || "The selected fields could not be applied.",
        );
        return;
      }
      router.refresh();
    } catch {
      setMessage(
        "The selected fields could not be applied. Your draft is still here.",
      );
    } finally {
      setApplying(false);
    }
  }

  if (!canUpdate) return null;

  return (
    <section
      aria-labelledby="person-web-research-heading"
      className="border-border bg-card rounded-2xl border p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-primary text-xs font-semibold tracking-[0.16em] uppercase">
            Assisted research
          </p>
          <h2
            id="person-web-research-heading"
            className="mt-2 text-xl font-semibold"
          >
            Check public sources
          </h2>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
            Research drafts suggestions only. It never sends contacts,
            addresses, identifiers, relationships, or private notes, and it
            never changes this record until you accept individual fields.
          </p>
        </div>
      </div>
      {message ? (
        <p
          role="alert"
          className="bg-destructive/10 text-destructive mt-4 rounded-xl p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      <label className="mt-5 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-1 size-4 accent-[var(--primary)]"
        />
        <span>
          I understand and want to search public web sources for this person.
        </span>
      </label>
      <Button
        className="mt-4"
        type="button"
        onClick={() => void research()}
        disabled={!consent || pending}
      >
        {pending ? "Researching…" : "Research this person"}
      </Button>

      {searched ? (
        <div className="mt-6 space-y-4">
          <div>
            <h3 className="font-semibold">Review suggestions</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {suggestions.length > 0
                ? "Nothing is selected by default. Edit any value before accepting it."
                : "No supported field suggestions were returned for review."}
            </p>
            {disclosure ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Provider: {disclosure.provider} · Model: {disclosure.model}
              </p>
            ) : null}
            {sources.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {sources.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {source.title}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
          {suggestions.map((suggestion) => {
            const label = fieldLabels[suggestion.field] ?? suggestion.field;
            const checked = selected.has(suggestion.field);
            return (
              <div
                key={suggestion.field}
                className="border-border rounded-xl border p-4"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Apply ${label}`}
                    checked={checked}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(suggestion.field);
                      else next.delete(suggestion.field);
                      setSelected(next);
                    }}
                    className="mt-1 size-4 accent-[var(--primary)]"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Label htmlFor={`research-${suggestion.field}`}>
                      {label}
                    </Label>
                    {suggestion.field === "biography" ? (
                      <textarea
                        id={`research-${suggestion.field}`}
                        aria-label={`${label} suggestion`}
                        value={drafts[suggestion.field] ?? ""}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [suggestion.field]: event.target.value,
                          }))
                        }
                        rows={4}
                        className="border-input bg-background w-full rounded-xl border px-3 py-2 text-sm"
                      />
                    ) : (
                      <Input
                        id={`research-${suggestion.field}`}
                        aria-label={`${label} suggestion`}
                        value={drafts[suggestion.field] ?? ""}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [suggestion.field]: event.target.value,
                          }))
                        }
                      />
                    )}
                    <p className="text-muted-foreground text-xs">
                      Source-backed suggestion; review the linked public sources
                      above.
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
          {suggestions.length > 0 ? (
            <Button
              type="button"
              onClick={() => void applySelected()}
              disabled={applying || selectedSuggestions.length === 0}
            >
              {applying ? "Applying…" : "Apply selected fields"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
