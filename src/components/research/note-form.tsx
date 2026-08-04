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
import { CreateNoteDocument } from "@/graphql/generated/graphql";

export function NoteForm({ personId }: { personId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    setPending(true);
    setFeedback(null);
    const result = await executeBrowserGraphQL(CreateNoteDocument, {
      input: {
        subject: { personId },
        content: { plainText: String(data.get("note") ?? "") },
        sensitivity: String(data.get("sensitivity")) as
          "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
      },
    });
    setPending(false);
    if (!result.ok) {
      setFeedback(
        transportMutationFeedback(
          result.errors,
          "The note could not be saved.",
        ),
      );
      return;
    }
    const payload = result.data.createNote;
    if (!payload?.note) {
      setFeedback(
        payloadMutationFeedback({
          code: payload?.code,
          currentVersion: payload?.currentVersion,
          fallback: "The note could not be saved. Your draft is still here.",
          issues: payload?.issues,
          requestId: result.requestId,
        }),
      );
      return;
    }
    formElement.reset();
    router.refresh();
  }
  const noteIssue = fieldMutationIssue(
    feedback,
    "content",
    "plainText",
    "note",
  );
  const sensitivityIssue = fieldMutationIssue(feedback, "sensitivity");
  return (
    <form
      aria-label="Add note"
      className="border-border bg-card space-y-4 rounded-2xl border p-5"
      onSubmit={submit}
    >
      <h2 className="font-semibold">Add a note</h2>
      {feedback ? (
        <MutationFeedback
          feedback={feedback}
          title="Note not saved"
          onReload={
            feedback.code === "CONFLICT" ? () => router.refresh() : undefined
          }
        />
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="note-content">Note</Label>
        <textarea
          id="note-content"
          name="note"
          required
          rows={4}
          aria-describedby={noteIssue ? "note-content-error" : undefined}
          aria-invalid={Boolean(noteIssue)}
          className="border-input bg-background w-full rounded-xl border px-3 py-2 text-sm"
        />
        {noteIssue ? (
          <p id="note-content-error" className="text-destructive text-sm">
            {noteIssue.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="note-sensitivity">Sensitivity</Label>
        <select
          id="note-sensitivity"
          name="sensitivity"
          defaultValue="INTERNAL"
          aria-describedby={
            sensitivityIssue ? "note-sensitivity-error" : undefined
          }
          aria-invalid={Boolean(sensitivityIssue)}
          className="border-input bg-background min-h-11 rounded-xl border px-3 text-sm"
        >
          <option>PUBLIC</option>
          <option>INTERNAL</option>
          <option>CONFIDENTIAL</option>
          <option>RESTRICTED</option>
        </select>
        {sensitivityIssue ? (
          <p id="note-sensitivity-error" className="text-destructive text-sm">
            {sensitivityIssue.message}
          </p>
        ) : null}
      </div>
      <Button disabled={pending} type="submit">
        {pending ? "Saving…" : "Add note"}
      </Button>
    </form>
  );
}
