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
    setPending(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(CreateRelationshipDocument, {
      input: {
        sourcePersonId,
        targetPersonId: String(data.get("targetPersonId")),
        relationshipTypeId: String(data.get("relationshipTypeId")),
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
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : "Add relationship"}
        </Button>
      </div>
    </form>
  );
}
