"use client";

import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import type { PublicGraphQLError } from "@/graphql/client";
import {
  type FragmentType,
  useFragment as readFragment,
} from "@/graphql/generated/fragment-masking";
import { MutationIssueFragmentDoc } from "@/graphql/generated/graphql";

export type MutationIssueView = {
  code: string;
  message: string;
  path: readonly string[];
};

export type MutationFeedbackView = {
  code: string;
  currentVersion?: number | null;
  fallback: string;
  issues: readonly MutationIssueView[];
  requestId?: string;
};

export function mutationFeedback(input: MutationFeedbackView) {
  return input;
}

export function mutationIssues(
  issues:
    readonly FragmentType<typeof MutationIssueFragmentDoc>[] | null | undefined,
): MutationIssueView[] {
  return readFragment(MutationIssueFragmentDoc, issues ?? []).map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
  }));
}

export function payloadMutationFeedback(input: {
  code?: string | null;
  currentVersion?: number | null;
  fallback: string;
  issues:
    readonly FragmentType<typeof MutationIssueFragmentDoc>[] | null | undefined;
  requestId?: string;
}): MutationFeedbackView {
  return mutationFeedback({
    code: input.code ?? "SAVE_FAILED",
    currentVersion: input.currentVersion,
    fallback: input.fallback,
    issues: mutationIssues(input.issues),
    requestId: input.requestId,
  });
}

export function transportMutationFeedback(
  errors: readonly PublicGraphQLError[],
  fallback: string,
): MutationFeedbackView {
  const first = errors[0];
  return {
    code: first?.code ?? "REQUEST_FAILED",
    fallback: first?.message ?? fallback,
    issues: errors.slice(1).map((error) => ({
      code: error.code,
      message: error.message,
      path: [],
    })),
    requestId: first?.requestId,
  };
}

export function fieldMutationIssue(
  feedback: MutationFeedbackView | null,
  ...fieldNames: string[]
): MutationIssueView | undefined {
  const names = new Set(fieldNames);
  return feedback?.issues.find((issue) =>
    issue.path.some((segment) => names.has(segment)),
  );
}

export function MutationFeedback({
  ariaLabel,
  feedback,
  onReload,
  onRetry,
  title,
}: {
  ariaLabel?: string;
  feedback: MutationFeedbackView;
  onReload?: () => void;
  onRetry?: () => void;
  title: string;
}) {
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    summaryRef.current?.focus();
  }, [feedback.code, feedback.requestId]);

  return (
    <div
      ref={summaryRef}
      aria-label={ariaLabel ?? title}
      role="alert"
      tabIndex={-1}
      className="border-destructive/35 bg-destructive/10 rounded-xl border p-4 text-sm"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{feedback.fallback}</p>
      <p className="text-muted-foreground mt-2 text-xs">
        Code: {feedback.code}
        {feedback.requestId ? ` · Request: ${feedback.requestId}` : ""}
      </p>
      {feedback.issues.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5">
          {feedback.issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.path.join(".")}-${index}`}>
              {issue.message} <span className="sr-only">({issue.code})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {feedback.code === "CONFLICT" ? (
        <div className="mt-3">
          <p>
            The record changed elsewhere
            {feedback.currentVersion != null
              ? ` (current version ${feedback.currentVersion})`
              : ""}
            .
          </p>
          {onReload ? (
            <Button
              className="mt-3"
              type="button"
              variant="outline"
              onClick={onReload}
            >
              Reload current data
            </Button>
          ) : null}
        </div>
      ) : null}
      {onRetry ? (
        <Button
          className="mt-3"
          type="button"
          variant="outline"
          onClick={onRetry}
        >
          Retry remaining step
        </Button>
      ) : null}
    </div>
  );
}
