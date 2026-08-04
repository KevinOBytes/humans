"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import {
  MutationFeedback,
  fieldMutationIssue,
  mutationFeedback,
  payloadMutationFeedback,
  transportMutationFeedback,
  type MutationFeedbackView,
} from "@/components/research/mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CreateEvidenceItemDocument,
  CreateSourceDocument,
  LinkFactEvidenceDocument,
} from "@/graphql/generated/graphql";

async function checksum(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type EvidenceProgress = {
  evidenceItemId?: string;
  excerpt?: string;
  sourceId: string;
  title: string;
  url: string;
};

export function EvidenceAssociationForm({
  facts,
}: {
  facts: readonly { id: string; label: string }[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedbackView | null>(null);
  const [progress, setProgress] = useState<EvidenceProgress | null>(null);
  if (!facts.length)
    return (
      <p className="text-muted-foreground text-sm">
        Add a fact or continue through the fact options before linking evidence.
      </p>
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const title = progress?.title ?? String(data.get("title") ?? "");
    const url = progress?.url ?? String(data.get("url") ?? "");
    const excerpt = progress?.evidenceItemId
      ? (progress.excerpt ?? "")
      : String(data.get("excerpt") ?? "");
    const factId = String(data.get("factId") ?? "");
    setPending(true);
    setFeedback(null);

    let nextProgress = progress;
    if (!nextProgress?.sourceId) {
      const source = await executeBrowserGraphQL(CreateSourceDocument, {
        input: {
          kind: "web",
          title,
          canonicalUrl: url || undefined,
          sensitivity: "INTERNAL",
        },
      });
      if (!source.ok) {
        setPending(false);
        setFeedback(
          transportMutationFeedback(
            source.errors,
            "The evidence source could not be saved.",
          ),
        );
        return;
      }
      const payload = source.data.createSource;
      const sourceId = payload?.source?.id;
      if (!sourceId) {
        setPending(false);
        setFeedback(
          payloadMutationFeedback({
            code: payload?.code,
            currentVersion: payload?.currentVersion,
            fallback:
              "The evidence source could not be saved. Your draft remains here.",
            issues: payload?.issues,
            requestId: source.requestId,
          }),
        );
        return;
      }
      nextProgress = { sourceId, title, url };
      setProgress(nextProgress);
    }

    if (!nextProgress.evidenceItemId) {
      const evidence = await executeBrowserGraphQL(CreateEvidenceItemDocument, {
        input: {
          sourceId: nextProgress.sourceId,
          checksum: await checksum(`${title}\n${url}\n${excerpt}`),
          externalLocator: url || undefined,
          extractedText: excerpt || undefined,
          sensitivity: "INTERNAL",
        },
      });
      if (!evidence.ok) {
        setPending(false);
        setFeedback(
          transportMutationFeedback(
            evidence.errors,
            "The source was saved, but the evidence record was not.",
          ),
        );
        return;
      }
      const payload = evidence.data.createEvidenceItem;
      const evidenceItemId = payload?.evidenceItem?.id;
      if (!evidenceItemId) {
        setPending(false);
        setFeedback(
          payloadMutationFeedback({
            code: payload?.code,
            currentVersion: payload?.currentVersion,
            fallback:
              "The source was saved, but the evidence record was not. Retry will continue from the saved source.",
            issues: payload?.issues,
            requestId: evidence.requestId,
          }),
        );
        return;
      }
      nextProgress = { ...nextProgress, evidenceItemId, excerpt };
      setProgress(nextProgress);
    }
    if (!nextProgress.evidenceItemId) {
      setPending(false);
      setFeedback(
        mutationFeedback({
          code: "INCOMPLETE_EVIDENCE",
          fallback:
            "The evidence record is incomplete. Retry from the saved source.",
          issues: [],
        }),
      );
      return;
    }

    const link = await executeBrowserGraphQL(LinkFactEvidenceDocument, {
      input: {
        factId,
        evidenceItemId: nextProgress.evidenceItemId,
        excerpt: excerpt || undefined,
        locator: url || undefined,
        supportStrength: 0.5,
      },
    });
    setPending(false);
    if (!link.ok) {
      setFeedback(
        transportMutationFeedback(
          link.errors,
          "The source and evidence record were saved, but the fact link failed.",
        ),
      );
      return;
    }
    const payload = link.data.linkFactEvidence;
    if (!payload?.factEvidence) {
      setFeedback(
        payloadMutationFeedback({
          code: payload?.code,
          currentVersion: payload?.currentVersion,
          fallback:
            "The source and evidence record were saved, but the fact link failed. Retry will only repeat the link.",
          issues: payload?.issues,
          requestId: link.requestId,
        }),
      );
      return;
    }
    formElement.reset();
    setProgress(null);
    router.refresh();
  }

  const titleIssue = fieldMutationIssue(feedback, "title");
  const urlIssue = fieldMutationIssue(
    feedback,
    "canonicalUrl",
    "externalLocator",
    "locator",
  );
  const factIssue = fieldMutationIssue(feedback, "factId");
  const excerptIssue = fieldMutationIssue(feedback, "excerpt", "extractedText");
  return (
    <form
      ref={formRef}
      aria-label="Link evidence"
      className="border-border bg-card grid gap-4 rounded-2xl border p-5 sm:grid-cols-2"
      onSubmit={submit}
    >
      <h2 className="font-semibold sm:col-span-2">Add linked evidence</h2>
      {progress ? (
        <p role="status" className="text-primary text-sm sm:col-span-2">
          {progress.evidenceItemId
            ? "Source and evidence record saved; retry will continue with the fact link."
            : "Source saved; retry will continue with the evidence record."}
        </p>
      ) : null}
      {feedback ? (
        <div className="sm:col-span-2">
          <MutationFeedback
            feedback={feedback}
            title="Evidence association incomplete"
            onRetry={
              progress ? () => formRef.current?.requestSubmit() : undefined
            }
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="evidence-title">Source title</Label>
        <Input
          id="evidence-title"
          name="title"
          defaultValue={progress?.title}
          disabled={Boolean(progress?.sourceId)}
          required
          aria-describedby={titleIssue ? "evidence-title-error" : undefined}
          aria-invalid={Boolean(titleIssue)}
        />
        {titleIssue ? (
          <p id="evidence-title-error" className="text-destructive text-sm">
            {titleIssue.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="evidence-url">Source URL</Label>
        <Input
          id="evidence-url"
          name="url"
          type="url"
          defaultValue={progress?.url}
          disabled={Boolean(progress?.sourceId)}
          aria-describedby={urlIssue ? "evidence-url-error" : undefined}
          aria-invalid={Boolean(urlIssue)}
        />
        {urlIssue ? (
          <p id="evidence-url-error" className="text-destructive text-sm">
            {urlIssue.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="evidence-fact">Fact</Label>
        <select
          id="evidence-fact"
          name="factId"
          aria-describedby={factIssue ? "evidence-fact-error" : undefined}
          aria-invalid={Boolean(factIssue)}
          className="border-input bg-background min-h-11 w-full rounded-xl border px-3 text-sm"
        >
          {facts.map((fact) => (
            <option key={fact.id} value={fact.id}>
              {fact.label}
            </option>
          ))}
        </select>
        {factIssue ? (
          <p id="evidence-fact-error" className="text-destructive text-sm">
            {factIssue.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="evidence-excerpt">Excerpt</Label>
        <textarea
          id="evidence-excerpt"
          name="excerpt"
          defaultValue={progress?.excerpt}
          disabled={Boolean(progress?.evidenceItemId)}
          rows={4}
          aria-describedby={excerptIssue ? "evidence-excerpt-error" : undefined}
          aria-invalid={Boolean(excerptIssue)}
          className="border-input bg-background w-full rounded-xl border px-3 py-2 text-sm"
        />
        {excerptIssue ? (
          <p id="evidence-excerpt-error" className="text-destructive text-sm">
            {excerptIssue.message}
          </p>
        ) : null}
      </div>
      <div className="sm:col-span-2">
        <Button disabled={pending} type="submit">
          {pending
            ? "Working…"
            : progress
              ? "Retry remaining step"
              : "Add evidence"}
        </Button>
      </div>
    </form>
  );
}
