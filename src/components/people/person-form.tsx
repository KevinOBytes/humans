"use client";

import { useState, type FormEvent, type ReactNode } from "react";

import {
  MutationFeedback,
  fieldMutationIssue,
  mutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PersonFormInput = {
  biography?: string;
  displayName: string;
  preferredName?: string;
  sensitivity: "CONFIDENTIAL" | "INTERNAL" | "PUBLIC" | "RESTRICTED";
  sortName?: string;
  status: "ACTIVE" | "DECEASED" | "MISSING" | "UNKNOWN";
};

export type PersonFormResult = {
  code?: string | null;
  currentVersion?: number | null;
  issues?: readonly {
    code: string;
    message: string;
    path: readonly string[];
  }[];
  person?: { id: string; version: number } | null;
  requestId?: string;
};

export type PersonFormProps = {
  cancelLabel?: string;
  initial?: Partial<PersonFormInput>;
  onCancel?: () => void;
  onReload?: () => void;
  onSaved?: (personId: string) => void;
  submit: (input: PersonFormInput) => Promise<PersonFormResult>;
  submitLabel?: string;
};

type FieldId =
  | "displayName"
  | "preferredName"
  | "sortName"
  | "biography"
  | "status"
  | "sensitivity";

function valueFrom(form: FormData, key: FieldId) {
  return String(form.get(key) ?? "");
}

export function PersonForm({
  cancelLabel = "Cancel",
  initial,
  onCancel,
  onReload,
  onSaved,
  submit,
  submitLabel = "Create person",
}: PersonFormProps) {
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  const [pending, setPending] = useState(false);

  const fieldIssue = (field: FieldId) => fieldMutationIssue(feedback, field);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setFeedback(null);
    const data = new FormData(event.currentTarget);
    const input: PersonFormInput = {
      displayName: valueFrom(data, "displayName"),
      preferredName: valueFrom(data, "preferredName") || undefined,
      sortName: valueFrom(data, "sortName") || undefined,
      biography: valueFrom(data, "biography") || undefined,
      status: valueFrom(data, "status") as PersonFormInput["status"],
      sensitivity: valueFrom(
        data,
        "sensitivity",
      ) as PersonFormInput["sensitivity"],
    };

    try {
      const result = await submit(input);
      if (result.person) {
        onSaved?.(result.person.id);
        return;
      }
      setFeedback(
        mutationFeedback({
          code: result.code ?? "SAVE_FAILED",
          currentVersion: result.currentVersion,
          fallback: "The person could not be saved. Your draft is still here.",
          issues: result.issues ?? [],
          requestId: result.requestId,
        }),
      );
    } catch {
      setFeedback(
        mutationFeedback({
          code: "REQUEST_FAILED",
          fallback: "The person could not be saved. Your draft is still here.",
          issues: [],
        }),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Person form"
      className="space-y-6"
      onSubmit={handleSubmit}
    >
      {feedback ? (
        <MutationFeedback
          ariaLabel="Fix form errors"
          feedback={feedback}
          onReload={onReload}
          title="We could not save this person"
        />
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          id="displayName"
          label="Display name"
          issue={fieldIssue("displayName")}
        >
          <Input
            id="displayName"
            name="displayName"
            defaultValue={initial?.displayName ?? ""}
            aria-describedby={
              fieldIssue("displayName") ? "displayName-error" : undefined
            }
            aria-invalid={Boolean(fieldIssue("displayName"))}
            autoComplete="off"
          />
        </FormField>
        <FormField
          id="preferredName"
          label="Preferred name"
          issue={fieldIssue("preferredName")}
        >
          <Input
            id="preferredName"
            name="preferredName"
            defaultValue={initial?.preferredName ?? ""}
            aria-describedby={
              fieldIssue("preferredName") ? "preferredName-error" : undefined
            }
            aria-invalid={Boolean(fieldIssue("preferredName"))}
            autoComplete="off"
          />
        </FormField>
        <FormField
          id="sortName"
          label="Sort name"
          issue={fieldIssue("sortName")}
        >
          <Input
            id="sortName"
            name="sortName"
            defaultValue={initial?.sortName ?? ""}
            aria-describedby={
              fieldIssue("sortName") ? "sortName-error" : undefined
            }
            aria-invalid={Boolean(fieldIssue("sortName"))}
            autoComplete="off"
          />
        </FormField>
        <FormField id="status" label="Status" issue={fieldIssue("status")}>
          <select
            id="status"
            name="status"
            defaultValue={initial?.status ?? "UNKNOWN"}
            aria-describedby={fieldIssue("status") ? "status-error" : undefined}
            aria-invalid={Boolean(fieldIssue("status"))}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3.5 text-[16px] sm:text-sm"
          >
            <option value="ACTIVE">Active</option>
            <option value="DECEASED">Deceased</option>
            <option value="MISSING">Missing</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </FormField>
        <FormField
          id="sensitivity"
          label="Sensitivity"
          issue={fieldIssue("sensitivity")}
        >
          <select
            id="sensitivity"
            name="sensitivity"
            defaultValue={initial?.sensitivity ?? "INTERNAL"}
            aria-describedby={
              fieldIssue("sensitivity") ? "sensitivity-error" : undefined
            }
            aria-invalid={Boolean(fieldIssue("sensitivity"))}
            className="border-input bg-background min-h-11 w-full rounded-xl border px-3.5 text-[16px] sm:text-sm"
          >
            <option value="PUBLIC">Public</option>
            <option value="INTERNAL">Internal</option>
            <option value="CONFIDENTIAL">Confidential</option>
            <option value="RESTRICTED">Restricted</option>
          </select>
        </FormField>
      </div>
      <FormField
        id="biography"
        label="Biography"
        issue={fieldIssue("biography")}
      >
        <textarea
          id="biography"
          name="biography"
          defaultValue={initial?.biography ?? ""}
          aria-describedby={
            fieldIssue("biography") ? "biography-error" : undefined
          }
          aria-invalid={Boolean(fieldIssue("biography"))}
          rows={6}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/25 w-full rounded-xl border px-3.5 py-3 text-[16px] outline-none focus-visible:ring-2 sm:text-sm"
        />
      </FormField>
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function FormField({
  children,
  id,
  issue,
  label,
}: {
  children: ReactNode;
  id: FieldId;
  issue?: { message: string } | null;
  label: string;
}) {
  return (
    <div className={id === "biography" ? "space-y-2" : "space-y-2"}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {issue ? (
        <p id={`${id}-error`} className="text-destructive text-sm font-medium">
          {issue.message}
        </p>
      ) : null}
    </div>
  );
}
