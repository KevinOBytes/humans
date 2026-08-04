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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CreateTagDocument,
  TagPersonDocument,
  WorkspaceTagsDocument,
} from "@/graphql/generated/graphql";

export type TagOption = {
  color?: string | null;
  id: string;
  name: string;
  normalizedName: string;
};

function normalizedTagName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function TagForm({
  canCreate,
  personId,
  tags,
}: {
  canCreate: boolean;
  personId: string;
  tags: readonly TagOption[];
}) {
  const router = useRouter();
  const firstChoice = tags[0]?.id ?? (canCreate ? "__new__" : "");
  const [choice, setChoice] = useState(firstChoice);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  if (!tags.length && !canCreate)
    return (
      <p className="text-muted-foreground text-sm">
        No reusable workspace tags are available on this page.
      </p>
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !choice) return;
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const name = String(data.get("name") ?? "");
    const color = String(data.get("color") ?? "") || undefined;
    setPending(true);
    setFeedback(null);
    let tagId = choice === "__new__" ? null : choice;
    let conflict: MutationFeedbackView | null = null;

    if (!tagId) {
      const created = await executeBrowserGraphQL(CreateTagDocument, {
        input: { name, color },
      });
      if (!created.ok) {
        setPending(false);
        setFeedback(
          transportMutationFeedback(
            created.errors,
            "The tag could not be created.",
          ),
        );
        return;
      }
      const payload = created.data.createTag;
      tagId = payload?.tag?.id ?? null;
      if (!tagId && payload?.code === "CONFLICT") {
        conflict = payloadMutationFeedback({
          code: payload.code,
          currentVersion: payload.currentVersion,
          fallback:
            "A tag with this name already exists. Humans will try to apply the existing tag.",
          issues: payload.issues,
          requestId: created.requestId,
        });
        const normalized = normalizedTagName(name);
        const found = await executeBrowserGraphQL(WorkspaceTagsDocument, {
          first: 25,
          filter: { normalizedNamePrefix: normalized },
        });
        tagId = found.ok
          ? ((found.data.tags?.nodes ?? []).find(
              (tag) => tag?.normalizedName === normalized,
            )?.id ?? null)
          : null;
      }
      if (!tagId) {
        setPending(false);
        setFeedback(
          conflict ??
            payloadMutationFeedback({
              code: payload?.code,
              currentVersion: payload?.currentVersion,
              fallback:
                "The tag could not be created. Your draft is still here.",
              issues: payload?.issues,
              requestId: created.requestId,
            }),
        );
        return;
      }
    }

    const applied = await executeBrowserGraphQL(TagPersonDocument, {
      input: { personId, tagId },
    });
    setPending(false);
    if (!applied.ok) {
      setFeedback(
        transportMutationFeedback(
          applied.errors,
          "The tag could not be applied.",
        ),
      );
      return;
    }
    const payload = applied.data.tagPerson;
    if (!payload?.personTag) {
      setFeedback(
        payloadMutationFeedback({
          code: payload?.code,
          currentVersion: payload?.currentVersion,
          fallback:
            "The tag could not be applied. Your selection is unchanged.",
          issues: payload?.issues,
          requestId: applied.requestId,
        }),
      );
      return;
    }
    formElement.reset();
    setChoice(firstChoice);
    router.refresh();
  }

  const tagIdIssue = fieldMutationIssue(feedback, "tagId");
  const nameIssue = fieldMutationIssue(feedback, "name");
  const colorIssue = fieldMutationIssue(feedback, "color");
  return (
    <form
      aria-label="Apply tag"
      className="border-border bg-card grid gap-4 rounded-2xl border p-5 sm:grid-cols-[1fr_10rem_auto]"
      onSubmit={submit}
    >
      <h2 className="font-semibold sm:col-span-3">Apply a workspace tag</h2>
      {feedback ? (
        <div className="sm:col-span-3">
          <MutationFeedback feedback={feedback} title="Tag not applied" />
        </div>
      ) : null}
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="tag-choice">Tag</Label>
        <select
          id="tag-choice"
          name="tagChoice"
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
            setFeedback(null);
          }}
          aria-describedby={tagIdIssue ? "tag-choice-error" : undefined}
          aria-invalid={Boolean(tagIdIssue)}
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
          {canCreate ? (
            <option value="__new__">Create a new tag…</option>
          ) : null}
        </select>
        {tagIdIssue ? (
          <p id="tag-choice-error" className="text-destructive text-sm">
            {tagIdIssue.message}
          </p>
        ) : null}
      </div>
      {choice === "__new__" ? (
        <>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="tag-name">New tag name</Label>
            <Input
              id="tag-name"
              name="name"
              required
              aria-describedby={nameIssue ? "tag-name-error" : undefined}
              aria-invalid={Boolean(nameIssue)}
            />
            {nameIssue ? (
              <p id="tag-name-error" className="text-destructive text-sm">
                {nameIssue.message}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="tag-color">Color</Label>
            <Input
              id="tag-color"
              name="color"
              placeholder="#3b82f6"
              pattern="#[0-9a-fA-F]{6}"
              aria-describedby={colorIssue ? "tag-color-error" : undefined}
              aria-invalid={Boolean(colorIssue)}
            />
            {colorIssue ? (
              <p id="tag-color-error" className="text-destructive text-sm">
                {colorIssue.message}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
      <Button className="self-end" disabled={pending} type="submit">
        {pending ? "Applying…" : "Apply tag"}
      </Button>
    </form>
  );
}
