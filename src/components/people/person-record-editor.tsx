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
import { executeBrowserGraphQL, type GraphQLResult } from "@/graphql/client";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  CreatePersonEventDocument,
  CreatePersonNameDocument,
  MutationIssueFragmentDoc,
  type PersonNameKind,
  type CreatePersonEventMutation,
  type CreatePersonNameMutation,
} from "@/graphql/generated/graphql";

function isoDate(value: FormDataEntryValue | null): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function PersonRecordEditor({ personId }: { personId: string }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  const [pending, setPending] = useState(false);

  async function createName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending(true);
    setFeedback(null);
    const data = new FormData(form);
    let result: GraphQLResult<CreatePersonNameMutation>;
    try {
      result = await executeBrowserGraphQL(CreatePersonNameDocument, {
        input: {
          personId,
          fullName: String(data.get("name-fullName") ?? ""),
          kind: String(data.get("name-kind") ?? "OTHER") as PersonNameKind,
        },
      });
    } catch {
      setFeedback({
        code: "REQUEST_FAILED",
        fallback: "The name could not be saved.",
        issues: [],
      });
      setPending(false);
      return;
    }
    setPending(false);
    if (!result.ok) {
      setFeedback({
        code: result.errors[0]?.code ?? "SAVE_FAILED",
        fallback: "The name could not be saved.",
        issues: [],
      });
      return;
    }
    const payload = result.data.createPersonName;
    if (!payload.name) {
      setFeedback({
        code: payload.code ?? "SAVE_FAILED",
        fallback: "The name could not be saved.",
        issues: readFragment(MutationIssueFragmentDoc, payload.issues),
        requestId: result.requestId,
      });
      return;
    }
    form.reset();
    router.refresh();
  }

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending(true);
    setFeedback(null);
    const data = new FormData(form);
    let result: GraphQLResult<CreatePersonEventMutation>;
    try {
      result = await executeBrowserGraphQL(CreatePersonEventDocument, {
        input: {
          personId,
          eventKind: String(data.get("event-kind") ?? ""),
          title: String(data.get("event-title") ?? ""),
          description: String(data.get("event-description") ?? "") || undefined,
          earliestAt: isoDate(data.get("event-earliestAt")),
          latestAt: isoDate(data.get("event-latestAt")),
        },
      });
    } catch {
      setFeedback({
        code: "REQUEST_FAILED",
        fallback: "The timeline event could not be saved.",
        issues: [],
      });
      setPending(false);
      return;
    }
    setPending(false);
    if (!result.ok) {
      setFeedback({
        code: result.errors[0]?.code ?? "SAVE_FAILED",
        fallback: "The timeline event could not be saved.",
        issues: [],
      });
      return;
    }
    const payload = result.data.createPersonEvent;
    if (!payload.event) {
      setFeedback({
        code: payload.code ?? "SAVE_FAILED",
        fallback: "The timeline event could not be saved.",
        issues: readFragment(MutationIssueFragmentDoc, payload.issues),
        requestId: result.requestId,
      });
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <section className="border-border bg-card rounded-2xl border p-5">
      <h2 className="text-lg font-semibold">Add names and timeline events</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Record alternate names and dated milestones without leaving this person
        profile.
      </p>
      {feedback ? (
        <div className="mt-4">
          <MutationFeedback
            feedback={feedback}
            title="Record could not be saved"
          />
        </div>
      ) : null}
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <form
          className="space-y-4"
          onSubmit={(event) => void createName(event)}
        >
          <h3 className="font-semibold">Alternate name</h3>
          <div>
            <Label htmlFor="name-fullName">Full name</Label>
            <Input
              id="name-fullName"
              name="name-fullName"
              className="mt-2"
              required
            />
          </div>
          <div>
            <Label htmlFor="name-kind">Kind</Label>
            <select
              id="name-kind"
              name="name-kind"
              defaultValue="OTHER"
              className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3.5 text-[16px] sm:text-sm"
            >
              <option value="LEGAL">Legal</option>
              <option value="PREFERRED">Preferred</option>
              <option value="BIRTH">Birth</option>
              <option value="MARRIED">Married</option>
              <option value="FORMER">Former</option>
              <option value="ALIAS">Alias</option>
              <option value="TRANSLITERATION">Transliteration</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <Button type="submit" disabled={pending}>
            Save name
          </Button>
        </form>

        <form
          className="space-y-4"
          onSubmit={(event) => void createEvent(event)}
        >
          <h3 className="font-semibold">Timeline event</h3>
          <div>
            <Label htmlFor="event-kind">Event kind</Label>
            <Input
              id="event-kind"
              name="event-kind"
              className="mt-2"
              placeholder="education, residence, career"
              required
            />
          </div>
          <div>
            <Label htmlFor="event-title">Title</Label>
            <Input
              id="event-title"
              name="event-title"
              className="mt-2"
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="event-earliestAt">Starts</Label>
              <Input
                id="event-earliestAt"
                name="event-earliestAt"
                type="datetime-local"
                className="mt-2"
              />
            </div>
            <div>
              <Label htmlFor="event-latestAt">Ends</Label>
              <Input
                id="event-latestAt"
                name="event-latestAt"
                type="datetime-local"
                className="mt-2"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="event-description">Description</Label>
            <textarea
              id="event-description"
              name="event-description"
              rows={3}
              className="border-input bg-background mt-2 w-full rounded-xl border px-3.5 py-3 text-[16px] sm:text-sm"
            />
          </div>
          <Button type="submit" disabled={pending}>
            Save event
          </Button>
        </form>
      </div>
    </section>
  );
}
