"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_QUESTION_BYTES = 8_000;
const MAX_SCOPE_IDS_PER_KIND = 100;
const MAX_POLL_DELAY_MS = 8_000;

export type AnalystRunState =
  "cancelled" | "completed" | "failed" | "pending" | "running";

type CountSummary = Readonly<{
  evidenceCount?: number;
  filterCount?: number;
  personCount?: number;
  resourceCount?: number;
  resultCount?: number;
  truncated?: boolean;
}>;

export type AnalystRun = Readonly<{
  answer: string | null;
  citations: readonly Readonly<{
    claimText: string;
    locator: string | null;
    resourceId: string;
    resourceKind: "evidence" | "person";
  }>[];
  completedAt: string | null;
  createdAt: string;
  errorCode: string | null;
  id: string;
  model: string;
  provider: "COMPATIBLE" | "OLLAMA" | "OPENAI";
  startedAt: string | null;
  state: AnalystRunState;
  toolCalls: readonly Readonly<{
    completedAt: string | null;
    inputSummary: CountSummary;
    name: string;
    resultSummary: CountSummary | null;
    startedAt: string | null;
    state: "completed" | "failed" | "pending" | "running";
  }>[];
}>;

export type StartAnalystInput = Readonly<{
  idempotencyKey: string;
  question: string;
  scope: Readonly<{
    evidenceIds: readonly string[];
    personIds: readonly string[];
  }>;
}>;

type RequestOptions = Readonly<{ signal: AbortSignal }>;

export type AnalystAdapter = Readonly<{
  cancel(id: string, options: RequestOptions): Promise<AnalystRun>;
  read(id: string, options: RequestOptions): Promise<AnalystRun>;
  start(input: StartAnalystInput, options: RequestOptions): Promise<AnalystRun>;
}>;

type AnalystProps = Readonly<{
  adapter: AnalystAdapter;
  canCancel: boolean;
  canStart: boolean;
  pollDelayMs?: number;
  workspaceIdentity: string;
}>;

type RetrySubmission = Readonly<{
  input: StartAnalystInput;
}>;

const terminalStates: ReadonlySet<AnalystRunState> = new Set([
  "cancelled",
  "completed",
  "failed",
]);

const stateLabels: Readonly<Record<AnalystRunState, string>> = {
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  pending: "Queued",
  running: "Running",
};

function parseScope(value: string): readonly string[] {
  const values = value
    .split(/[\s,]+/u)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    values.length > MAX_SCOPE_IDS_PER_KIND ||
    values.some((id) => !UUID.test(id))
  ) {
    throw new Error("INVALID_SCOPE");
  }
  return [...new Set(values)].sort();
}

function normalizedQuestion(value: string): string {
  const question = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const bytes = new TextEncoder().encode(question).length;
  if (bytes < 1 || bytes > MAX_QUESTION_BYTES) {
    throw new Error("INVALID_QUESTION");
  }
  return question;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "INTERNAL";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "INTERNAL";
}

function requestFailure(error: unknown): string {
  switch (errorCode(error)) {
    case "VALIDATION_FAILED":
      return "The analysis request is invalid. Review the scope and try again.";
    case "RATE_LIMITED":
      return "Analysis capacity is temporarily exhausted. Try again later.";
    case "PROVIDER_UNAVAILABLE":
    case "NETWORK_ERROR":
      return "Analysis is temporarily unavailable. Retry this submission when ready.";
    default:
      return "The analysis request could not be completed. Try again.";
  }
}

function runFailure(code: string | null): string {
  switch (code) {
    case "provider_timeout":
      return "The model provider timed out. You can submit a new analysis.";
    case "authorization_changed":
      return "Workspace authorization changed before the analysis completed.";
    case "analysis_limit_reached":
      return "The analysis reached its bounded execution limit. Narrow the question or scope and submit a new analysis.";
    case "input_unavailable":
      return "The selected research scope is no longer available.";
    case "provider_unavailable":
      return "The model provider was unavailable. You can submit a new analysis.";
    default:
      return "The analysis could not be completed. You can submit a new analysis.";
  }
}

function summaryText(summary: CountSummary): string {
  const parts: string[] = [];
  for (const [key, label] of [
    ["personCount", "person"],
    ["evidenceCount", "evidence item"],
    ["resourceCount", "resource"],
    ["resultCount", "result"],
    ["filterCount", "filter"],
  ] as const) {
    const value = summary[key];
    if (value !== undefined) {
      parts.push(`${value} ${label}${value === 1 ? "" : "s"}`);
    }
  }
  if (summary.truncated !== undefined) {
    parts.push(summary.truncated ? "truncated" : "not truncated");
  }
  return parts.length ? parts.join(", ") : "No counts reported";
}

export function Analyst(props: AnalystProps) {
  return <AnalystState key={props.workspaceIdentity} {...props} />;
}

function AnalystState({
  adapter,
  canCancel,
  canStart,
  pollDelayMs = 750,
}: AnalystProps) {
  const controllersRef = useRef(new Set<AbortController>());
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);
  const pollGenerationRef = useRef(0);
  const pollControllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const pollAttemptRef = useRef(0);
  const [question, setQuestion] = useState("");
  const [personIds, setPersonIds] = useState("");
  const [evidenceIds, setEvidenceIds] = useState("");
  const [run, setRun] = useState<AnalystRun | null>(null);
  const [pendingAction, setPendingAction] = useState<"cancel" | "start" | null>(
    null,
  );
  const [pollRevision, setPollRevision] = useState(0);
  const [retrySubmission, setRetrySubmission] =
    useState<RetrySubmission | null>(null);
  const [message, setMessage] = useState(
    canStart
      ? "Ask a bounded question over your authorized workspace data."
      : "You have permission to read analyst results, but not to start or cancel analysis in this workspace.",
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(
    () => () => {
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    },
    [],
  );

  function controller(): AbortController {
    const next = new AbortController();
    controllersRef.current.add(next);
    return next;
  }

  function release(request: AbortController): void {
    controllersRef.current.delete(request);
  }

  function acceptRun(next: AnalystRun): void {
    if (runIdRef.current && next.id !== runIdRef.current) return;
    runIdRef.current = next.id;
    setRun(next);
    setFormError(null);
    setMessage(
      next.state === "pending"
        ? "Analysis queued."
        : next.state === "running"
          ? "Analysis is running with authorized read-only tools."
          : next.state === "completed"
            ? "Analysis completed."
            : next.state === "cancelled"
              ? "Analysis cancelled."
              : "Analysis failed.",
    );
  }

  const activeRunId = run && !terminalStates.has(run.state) ? run.id : null;

  useEffect(() => {
    if (!activeRunId) return;
    const generation = ++pollGenerationRef.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      if (disposed || generation !== pollGenerationRef.current) return;
      const request = controller();
      pollControllerRef.current = request;
      void adapter
        .read(activeRunId, { signal: request.signal })
        .then((next) => {
          if (
            disposed ||
            request.signal.aborted ||
            generation !== pollGenerationRef.current
          )
            return;
          acceptRun(next);
          if (!terminalStates.has(next.state)) {
            pollAttemptRef.current += 1;
            timer = setTimeout(
              poll,
              Math.min(
                pollDelayMs * 2 ** pollAttemptRef.current,
                MAX_POLL_DELAY_MS,
              ),
            );
          }
        })
        .catch(() => {
          if (
            disposed ||
            request.signal.aborted ||
            generation !== pollGenerationRef.current
          )
            return;
          setMessage("Progress is temporarily unavailable. Retrying safely…");
          pollAttemptRef.current += 1;
          timer = setTimeout(
            poll,
            Math.min(
              pollDelayMs * 2 ** pollAttemptRef.current,
              MAX_POLL_DELAY_MS,
            ),
          );
        })
        .finally(() => {
          if (pollControllerRef.current === request) {
            pollControllerRef.current = null;
          }
          release(request);
        });
    };
    timer = setTimeout(poll, Math.max(1, pollDelayMs));
    return () => {
      disposed = true;
      if (pollGenerationRef.current === generation) {
        pollGenerationRef.current += 1;
      }
      if (timer) clearTimeout(timer);
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
    };
  }, [activeRunId, adapter, pollDelayMs, pollRevision]);

  useEffect(() => {
    if (run && terminalStates.has(run.state)) {
      completionHeadingRef.current?.focus();
    }
  }, [run]);

  function buildInput(): StartAnalystInput {
    const boundedQuestion = normalizedQuestion(question);
    const scope = {
      evidenceIds: parseScope(evidenceIds),
      personIds: parseScope(personIds),
    };
    return {
      idempotencyKey: crypto.randomUUID(),
      question: boundedQuestion,
      scope,
    };
  }

  async function start(input: StartAnalystInput): Promise<void> {
    if (pendingAction || (run && !terminalStates.has(run.state))) return;
    const request = controller();
    setPendingAction("start");
    setFormError(null);
    setMessage("Starting analysis…");
    runIdRef.current = null;
    try {
      const next = await adapter.start(input, { signal: request.signal });
      if (request.signal.aborted) return;
      setRetrySubmission(null);
      pollAttemptRef.current = 0;
      acceptRun(next);
    } catch (error) {
      if (request.signal.aborted) return;
      setRetrySubmission({ input });
      setFormError(requestFailure(error));
      setMessage("Analysis was not started.");
    } finally {
      release(request);
      if (!request.signal.aborted) setPendingAction(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pendingAction || (run && !terminalStates.has(run.state))) return;
    setFormError(null);
    let input: StartAnalystInput;
    try {
      input = buildInput();
    } catch (error) {
      setFormError(
        error instanceof Error && error.message === "INVALID_SCOPE"
          ? "Scope entries must be valid UUIDs, with no more than 100 per resource kind."
          : "Enter a question that is 8,000 UTF-8 bytes or fewer.",
      );
      return;
    }
    setRetrySubmission(null);
    void start(input);
  }

  async function cancel(): Promise<void> {
    if (!run || terminalStates.has(run.state) || pendingAction) return;
    pollGenerationRef.current += 1;
    pollControllerRef.current?.abort();
    pollControllerRef.current = null;
    const request = controller();
    setPendingAction("cancel");
    setFormError(null);
    setMessage("Cancelling analysis…");
    try {
      const next = await adapter.cancel(run.id, { signal: request.signal });
      if (!request.signal.aborted) acceptRun(next);
    } catch (error) {
      if (!request.signal.aborted) {
        setFormError(requestFailure(error));
        setMessage("Cancellation could not be confirmed.");
        setPollRevision((value) => value + 1);
      }
    } finally {
      release(request);
      if (!request.signal.aborted) setPendingAction(null);
    }
  }

  const active = Boolean(run && !terminalStates.has(run.state));
  const terminal = Boolean(run && terminalStates.has(run.state));

  return (
    <div className="mx-auto max-w-5xl space-y-7 overflow-hidden">
      <header>
        <p className="text-primary text-sm font-semibold">Research workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Cited analyst
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          Ask a scoped question over records you can currently read. Questions
          and answers are protected, and the model receives only authorized
          read-only research tools.
        </p>
      </header>

      {canStart ? (
        <form
          aria-labelledby="analyst-question-heading"
          className="border-border bg-card rounded-2xl border p-5 shadow-sm"
          onSubmit={submit}
        >
          <h2 id="analyst-question-heading" className="text-xl font-semibold">
            Ask a question
          </h2>
          <div className="mt-4">
            <Label htmlFor="analyst-question">Question</Label>
            <textarea
              id="analyst-question"
              className="border-input bg-background focus-visible:ring-ring mt-2 min-h-32 w-full resize-y rounded-xl border px-3 py-2 text-sm outline-none focus-visible:ring-2"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={8_000}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="analyst-question-help"
              disabled={pendingAction === "start"}
            />
            <p
              id="analyst-question-help"
              className="text-muted-foreground mt-2 text-xs"
            >
              Required. Maximum 8,000 UTF-8 bytes. The question is not added to
              the URL or browser storage.
            </p>
          </div>
          <fieldset className="mt-5">
            <legend className="text-sm font-semibold">
              Optional closed scope
            </legend>
            <p className="text-muted-foreground mt-1 text-xs">
              Add up to 100 comma- or space-separated UUIDs per resource kind.
            </p>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div className="min-w-0">
                <Label htmlFor="analyst-person-ids">Person scope UUIDs</Label>
                <Input
                  id="analyst-person-ids"
                  className="mt-2"
                  value={personIds}
                  onChange={(event) => setPersonIds(event.target.value)}
                  maxLength={3_800}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pendingAction === "start"}
                />
              </div>
              <div className="min-w-0">
                <Label htmlFor="analyst-evidence-ids">
                  Evidence scope UUIDs
                </Label>
                <Input
                  id="analyst-evidence-ids"
                  className="mt-2"
                  value={evidenceIds}
                  onChange={(event) => setEvidenceIds(event.target.value)}
                  maxLength={3_800}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pendingAction === "start"}
                />
              </div>
            </div>
          </fieldset>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button type="submit" disabled={Boolean(pendingAction) || active}>
              {pendingAction === "start"
                ? "Starting analysis…"
                : "Start analysis"}
            </Button>
            {retrySubmission ? (
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(pendingAction) || active}
                onClick={() => void start(retrySubmission.input)}
              >
                Retry submission
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <section className="border-border bg-card rounded-2xl border p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Read-only analyst access</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            You have permission to read prior runs, but not to start or cancel
            analysis in this workspace.
          </p>
        </section>
      )}

      <section
        className="border-border bg-card rounded-2xl border p-5 shadow-sm"
        aria-busy={active}
        aria-labelledby="analyst-progress-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="analyst-progress-heading" className="text-xl font-semibold">
              Analysis progress
            </h2>
            <p
              className="text-muted-foreground mt-1 text-sm"
              role="status"
              aria-live="polite"
            >
              {message}
            </p>
          </div>
          {run ? (
            <span className="bg-primary/10 text-primary rounded-full px-3 py-1 text-sm font-semibold">
              {stateLabels[run.state]}
            </span>
          ) : null}
        </div>
        {run ? (
          <p className="text-muted-foreground mt-3 text-xs break-words">
            Provider and model:{" "}
            <span className="text-foreground font-medium">
              {run.provider} · {run.model}
            </span>
          </p>
        ) : null}
        {active && canCancel ? (
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            disabled={Boolean(pendingAction)}
            onClick={() => void cancel()}
          >
            {pendingAction === "cancel"
              ? "Cancelling analysis…"
              : "Cancel analysis"}
          </Button>
        ) : null}
        {formError ? (
          <p className="text-destructive mt-4 text-sm" role="alert">
            {formError}
          </p>
        ) : null}
      </section>

      {terminal && run ? (
        <section className="border-border bg-card rounded-2xl border p-5 shadow-sm">
          <h2
            ref={completionHeadingRef}
            tabIndex={-1}
            className="focus-visible:ring-ring rounded text-xl font-semibold outline-none focus-visible:ring-2"
          >
            {run.state === "completed" ? "Cited answer" : "Analysis result"}
          </h2>
          {run.state === "completed" ? (
            <>
              <p className="mt-4 text-sm leading-6 break-words whitespace-pre-wrap">
                {run.answer ??
                  "The analysis completed without a public answer."}
              </p>
              <div className="mt-6">
                <h3 className="font-semibold">Validated citations</h3>
                {run.citations.length ? (
                  <ol className="mt-3 space-y-3">
                    {run.citations.map((citation, index) => {
                      const content = (
                        <>
                          <span className="font-medium">
                            {citation.claimText}
                          </span>
                          <span className="text-muted-foreground mt-1 block text-xs break-all">
                            {citation.resourceKind === "person"
                              ? "Person"
                              : "Evidence"}{" "}
                            resource {citation.resourceId}
                            {citation.locator ? ` · ${citation.locator}` : ""}
                          </span>
                        </>
                      );
                      return (
                        <li
                          key={`${citation.resourceKind}:${citation.resourceId}:${index}`}
                          className="min-w-0 text-sm"
                        >
                          {citation.resourceKind === "person" &&
                          UUID.test(citation.resourceId) ? (
                            <a
                              href={`/people/${citation.resourceId}`}
                              className="focus-visible:ring-ring block rounded-lg underline underline-offset-4 outline-none focus-visible:ring-2"
                            >
                              {content}
                            </a>
                          ) : (
                            content
                          )}
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="text-muted-foreground mt-2 text-sm">
                    No validated citations were returned.
                  </p>
                )}
              </div>
            </>
          ) : run.state === "failed" ? (
            <p className="text-destructive mt-4 text-sm" role="alert">
              {runFailure(run.errorCode)}
            </p>
          ) : (
            <p className="text-muted-foreground mt-4 text-sm">
              This analysis was cancelled before a cited answer was committed.
            </p>
          )}
        </section>
      ) : null}

      {run?.toolCalls.length ? (
        <section className="border-border bg-card rounded-2xl border p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Authorized tool activity</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Only approved tool names, states, and count summaries are shown.
          </p>
          <ul className="mt-4 space-y-3" aria-label="Tool activity">
            {run.toolCalls.map((tool, index) => (
              <li
                key={`${tool.name}:${index}`}
                className="border-border min-w-0 rounded-xl border p-4 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold break-all">{tool.name}</span>
                  <span className="text-muted-foreground capitalize">
                    {tool.state}
                  </span>
                </div>
                <p className="text-muted-foreground mt-2">
                  Input: {summaryText(tool.inputSummary)}
                </p>
                {tool.resultSummary ? (
                  <p className="text-muted-foreground mt-1">
                    Result: {summaryText(tool.resultSummary)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
