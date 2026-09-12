"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  MutationFeedback,
  fieldMutationIssue,
  payloadMutationFeedback,
  transportMutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import { CreateRelationshipDocument } from "@/graphql/generated/graphql";

function optionalUtcDate(
  value: FormDataEntryValue | null,
  yearBoundary?: "start" | "end",
) {
  const date = String(value ?? "").trim();
  if (!date) return null;
  const year = date.slice(0, 4);
  if (yearBoundary === "start") return `${year}-01-01T00:00:00.000Z`;
  if (yearBoundary === "end") return `${year}-12-31T23:59:59.999Z`;
  return `${date}T00:00:00.000Z`;
}

export function RelationshipForm({
  people,
  relationshipTypes,
  sourcePersonId,
}: {
  people: readonly { id: string; name: string }[];
  relationshipTypes: readonly { id: string; label: string }[];
  sourcePersonId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  const targets = people.filter((person) => person.id !== sourcePersonId);
  if (!relationshipTypes.length || !targets.length)
    return (
      <p className="text-muted-foreground text-sm">
        Add another person and an active relationship type before creating a
        relationship.
      </p>
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const temporalSemantics = String(data.get("temporalSemantics")) as
      | "EXACT"
      | "APPROXIMATE"
      | "BEFORE"
      | "AFTER"
      | "BETWEEN"
      | "YEAR_ONLY"
      | "UNKNOWN";
    const temporalPrecision = String(data.get("temporalPrecision")) as
      | "INSTANT"
      | "SECOND"
      | "MINUTE"
      | "HOUR"
      | "DAY"
      | "MONTH"
      | "YEAR"
      | "RANGE"
      | "UNKNOWN";
    const yearOnly = temporalSemantics === "YEAR_ONLY";
    setPending(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(CreateRelationshipDocument, {
      input: {
        sourcePersonId,
        targetPersonId: String(data.get("targetPersonId")),
        relationshipTypeId: String(data.get("relationshipTypeId")),
        governancePurpose: "research",
        explicitConfirmed: true,
        state: String(data.get("state")).toLowerCase(),
        confidence: Number(data.get("confidence")),
        temporalSemantics,
        temporalPrecision,
        validFrom: optionalUtcDate(
          data.get("validFrom"),
          yearOnly ? "start" : undefined,
        ),
        validUntil: optionalUtcDate(
          data.get("validUntil"),
          yearOnly ? "end" : undefined,
        ),
        observedAt: optionalUtcDate(data.get("observedAt")),
        creationMethod: String(data.get("creationMethod")).toLowerCase(),
        sensitivity: String(data.get("sensitivity")) as
          "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
      },
    });
    setPending(false);
    if (!result.ok) {
      setFeedback(
        transportMutationFeedback(
          result.errors,
          "The relationship could not be saved.",
        ),
      );
      return;
    }
    const payload = result.data.createRelationship;
    if (!payload?.relationship) {
      setFeedback(
        payloadMutationFeedback({
          code: payload?.code,
          currentVersion: payload?.currentVersion,
          fallback:
            "The relationship could not be saved. Your choices remain selected.",
          issues: payload?.issues,
          requestId: result.requestId,
        }),
      );
      return;
    }
    formElement.reset();
    router.refresh();
  }
  return (
    <form
      aria-label="Add relationship"
      className="border-border bg-card grid gap-4 rounded-2xl border p-5 sm:grid-cols-3"
      onSubmit={submit}
    >
      <h2 className="font-semibold sm:col-span-3">Add a relationship</h2>
      {feedback ? (
        <div className="sm:col-span-3">
          <MutationFeedback
            feedback={feedback}
            title="Relationship not saved"
            onReload={
              feedback.code === "CONFLICT" ? () => router.refresh() : undefined
            }
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="relationship-type">Relationship type</Label>
        <select
          id="relationship-type"
          name="relationshipTypeId"
          aria-describedby={
            fieldMutationIssue(feedback, "relationshipTypeId")
              ? "relationship-type-error"
              : undefined
          }
          aria-invalid={Boolean(
            fieldMutationIssue(feedback, "relationshipTypeId"),
          )}
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          {relationshipTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
        {fieldMutationIssue(feedback, "relationshipTypeId") ? (
          <p id="relationship-type-error" className="text-destructive text-sm">
            {fieldMutationIssue(feedback, "relationshipTypeId")!.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-state">Claim state</Label>
        <select
          id="relationship-state"
          name="state"
          defaultValue="ASSERTED"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          <option value="ASSERTED">Asserted</option>
          <option value="INFERRED">Inferred (hypothesis)</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-confidence">Confidence</Label>
        <input
          id="relationship-confidence"
          name="confidence"
          type="number"
          required
          min="0"
          max="1"
          step="0.01"
          defaultValue="1"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-origin">Origin</Label>
        <select
          id="relationship-origin"
          name="creationMethod"
          defaultValue="MANUAL"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          <option value="MANUAL">Manual</option>
          <option value="IMPORT">Import</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-temporal-semantics">
          Temporal meaning
        </Label>
        <select
          id="relationship-temporal-semantics"
          name="temporalSemantics"
          defaultValue="UNKNOWN"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          <option value="UNKNOWN">Unknown</option>
          <option value="EXACT">Exact</option>
          <option value="APPROXIMATE">Approximate</option>
          <option value="BEFORE">Before</option>
          <option value="AFTER">After</option>
          <option value="BETWEEN">Between</option>
          <option value="YEAR_ONLY">Year only</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-temporal-precision">Date precision</Label>
        <select
          id="relationship-temporal-precision"
          name="temporalPrecision"
          defaultValue="UNKNOWN"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          <option value="UNKNOWN">Unknown</option>
          <option value="DAY">Day</option>
          <option value="MONTH">Month</option>
          <option value="YEAR">Year</option>
          <option value="RANGE">Range</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-observed-at">Observed on</Label>
        <input
          id="relationship-observed-at"
          name="observedAt"
          type="date"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-valid-from">Valid from</Label>
        <input
          id="relationship-valid-from"
          name="validFrom"
          type="date"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-valid-until">Valid until</Label>
        <input
          id="relationship-valid-until"
          name="validUntil"
          type="date"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-target">Related person</Label>
        <select
          id="relationship-target"
          name="targetPersonId"
          aria-describedby={
            fieldMutationIssue(feedback, "targetPersonId")
              ? "relationship-target-error"
              : undefined
          }
          aria-invalid={Boolean(fieldMutationIssue(feedback, "targetPersonId"))}
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          {targets.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        {fieldMutationIssue(feedback, "targetPersonId") ? (
          <p
            id="relationship-target-error"
            className="text-destructive text-sm"
          >
            {fieldMutationIssue(feedback, "targetPersonId")!.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="relationship-sensitivity">Sensitivity</Label>
        <select
          id="relationship-sensitivity"
          name="sensitivity"
          defaultValue="INTERNAL"
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          <option>PUBLIC</option>
          <option>INTERNAL</option>
          <option>CONFIDENTIAL</option>
          <option>RESTRICTED</option>
        </select>
      </div>
      <div className="sm:col-span-3">
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          <input
            required
            type="checkbox"
            name="governanceConfirmation"
            className="size-4"
          />
          I confirm this relationship is supported by a permitted research
          purpose.
        </label>
      </div>
      <div className="sm:col-span-3">
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Add relationship"}
        </Button>
      </div>
    </form>
  );
}
