"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

import {
  MutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { executeBrowserGraphQL, type GraphQLResult } from "@/graphql/client";
import {
  ArchivePersonEventDocument,
  ArchivePersonNameDocument,
  UpdatePersonEventDocument,
  UpdatePersonNameDocument,
  type ArchivePersonEventMutation,
  type ArchivePersonNameMutation,
  type PersonEventSummaryFragment,
  type PersonNameKind,
  type PersonNameSummaryFragment,
  type UpdatePersonEventMutation,
  type UpdatePersonNameMutation,
} from "@/graphql/generated/graphql";

const nameKinds: PersonNameKind[] = [
  "LEGAL",
  "PREFERRED",
  "BIRTH",
  "MARRIED",
  "FORMER",
  "ALIAS",
  "TRANSLITERATION",
  "OTHER",
];

function mutationFeedback(
  code: string | null | undefined,
  fallback: string,
  requestId?: string,
): MutationFeedbackView {
  return { code: code ?? "SAVE_FAILED", fallback, issues: [], requestId };
}

export function PersonNameRowEditor({
  name,
  canUpdate,
  canDelete,
  dateLabel,
}: {
  name: PersonNameSummaryFragment;
  canUpdate: boolean;
  canDelete: boolean;
  dateLabel: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setFeedback(null);
    let result: GraphQLResult<UpdatePersonNameMutation>;
    try {
      result = await executeBrowserGraphQL(UpdatePersonNameDocument, {
        input: {
          id: name.id,
          expectedVersion: name.version,
          fullName: String(data.get("fullName") ?? ""),
          kind: String(data.get("kind") ?? "OTHER") as PersonNameKind,
        },
      });
    } catch {
      setFeedback(mutationFeedback(undefined, "The name could not be saved."));
      setPending(false);
      return;
    }
    setPending(false);
    if (!result.ok) {
      setFeedback(
        mutationFeedback(
          result.errors[0]?.code,
          "The name could not be saved.",
          result.errors[0]?.requestId,
        ),
      );
      return;
    }
    const payload = result.data.updatePersonName;
    if (!payload.name) {
      setFeedback(
        mutationFeedback(
          payload.code,
          "The name could not be saved.",
          result.requestId,
        ),
      );
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function archive() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    let result: GraphQLResult<ArchivePersonNameMutation>;
    try {
      result = await executeBrowserGraphQL(ArchivePersonNameDocument, {
        input: { id: name.id, expectedVersion: name.version },
      });
    } catch {
      setFeedback(
        mutationFeedback(undefined, "The name could not be archived."),
      );
      setPending(false);
      return;
    }
    setPending(false);
    if (!result.ok) {
      setFeedback(
        mutationFeedback(
          result.errors[0]?.code,
          "The name could not be archived.",
          result.errors[0]?.requestId,
        ),
      );
      return;
    }
    if (!result.data.archivePersonName.name) {
      setFeedback(
        mutationFeedback(
          result.data.archivePersonName.code,
          "The name could not be archived.",
          result.requestId,
        ),
      );
      return;
    }
    router.refresh();
  }

  return (
    <li className="border-border bg-card min-w-0 rounded-xl border p-4 [overflow-wrap:anywhere]">
      {feedback ? (
        <MutationFeedback feedback={feedback} title="Name update failed" />
      ) : null}
      {editing ? (
        <form className="space-y-3" onSubmit={(event) => void update(event)}>
          <div>
            <Label htmlFor={`name-fullName-${name.id}`}>Full name</Label>
            <Input
              id={`name-fullName-${name.id}`}
              name="fullName"
              className="mt-2"
              defaultValue={name.fullName}
              required
            />
          </div>
          <div>
            <Label htmlFor={`name-kind-${name.id}`}>Kind</Label>
            <select
              id={`name-kind-${name.id}`}
              name="kind"
              defaultValue={name.kind}
              className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3.5 text-[16px] sm:text-sm"
            >
              {nameKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save name"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{name.fullName}</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {name.kind.toLowerCase()}
              {dateLabel ? ` · ${dateLabel}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <Badge>{name.state.toLowerCase()}</Badge>
            {canUpdate ? (
              <Button
                type="button"
                variant="outline"
                aria-label={`Edit ${name.fullName}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                type="button"
                variant="outline"
                aria-label={`Archive ${name.fullName}`}
                disabled={pending}
                onClick={() => void archive()}
              >
                {pending ? "Archiving…" : "Archive"}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

export function PersonEventRowEditor({
  event,
  canUpdate,
  canDelete,
  dateLabel,
}: {
  event: PersonEventSummaryFragment;
  canUpdate: boolean;
  canDelete: boolean;
  dateLabel: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);

  async function update(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (pending) return;
    const data = new FormData(formEvent.currentTarget);
    setPending(true);
    setFeedback(null);
    let result: GraphQLResult<UpdatePersonEventMutation>;
    try {
      result = await executeBrowserGraphQL(UpdatePersonEventDocument, {
        input: {
          id: event.id,
          expectedVersion: event.version,
          eventKind: String(data.get("eventKind") ?? ""),
          title: String(data.get("title") ?? ""),
          description: String(data.get("description") ?? "") || null,
        },
      });
    } catch {
      setFeedback(mutationFeedback(undefined, "The event could not be saved."));
      setPending(false);
      return;
    }
    setPending(false);
    if (!result.ok) {
      setFeedback(
        mutationFeedback(
          result.errors[0]?.code,
          "The event could not be saved.",
          result.errors[0]?.requestId,
        ),
      );
      return;
    }
    if (!result.data.updatePersonEvent.event) {
      setFeedback(
        mutationFeedback(
          result.data.updatePersonEvent.code,
          "The event could not be saved.",
          result.requestId,
        ),
      );
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function archive() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    let result: GraphQLResult<ArchivePersonEventMutation>;
    try {
      result = await executeBrowserGraphQL(ArchivePersonEventDocument, {
        input: { id: event.id, expectedVersion: event.version },
      });
    } catch {
      setFeedback(
        mutationFeedback(undefined, "The event could not be archived."),
      );
      setPending(false);
      return;
    }
    setPending(false);
    if (!result.ok) {
      setFeedback(
        mutationFeedback(
          result.errors[0]?.code,
          "The event could not be archived.",
          result.errors[0]?.requestId,
        ),
      );
      return;
    }
    if (!result.data.archivePersonEvent.event) {
      setFeedback(
        mutationFeedback(
          result.data.archivePersonEvent.code,
          "The event could not be archived.",
          result.requestId,
        ),
      );
      return;
    }
    router.refresh();
  }

  return (
    <li className="border-border bg-card min-w-0 rounded-xl border p-4 [overflow-wrap:anywhere]">
      {feedback ? (
        <MutationFeedback feedback={feedback} title="Event update failed" />
      ) : null}
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(formEvent) => void update(formEvent)}
        >
          <div>
            <Label htmlFor={`event-kind-${event.id}`}>Event kind</Label>
            <Input
              id={`event-kind-${event.id}`}
              name="eventKind"
              className="mt-2"
              defaultValue={event.eventKind}
              required
            />
          </div>
          <div>
            <Label htmlFor={`event-title-${event.id}`}>Title</Label>
            <Input
              id={`event-title-${event.id}`}
              name="title"
              className="mt-2"
              defaultValue={event.title}
              required
            />
          </div>
          <div>
            <Label htmlFor={`event-description-${event.id}`}>Description</Label>
            <textarea
              id={`event-description-${event.id}`}
              name="description"
              className="border-input bg-background mt-2 w-full rounded-xl border px-3.5 py-3 text-[16px] sm:text-sm"
              rows={3}
              defaultValue={event.description ?? ""}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save event"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{event.title}</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {event.eventKind} · {dateLabel}
            </p>
            {event.description ? (
              <p className="text-muted-foreground mt-3 text-sm leading-6 whitespace-pre-wrap">
                {event.description}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <Badge>{event.state.toLowerCase()}</Badge>
            {canUpdate ? (
              <Button
                type="button"
                variant="outline"
                aria-label={`Edit ${event.title}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                type="button"
                variant="outline"
                aria-label={`Archive ${event.title}`}
                disabled={pending}
                onClick={() => void archive()}
              >
                {pending ? "Archiving…" : "Archive"}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}
