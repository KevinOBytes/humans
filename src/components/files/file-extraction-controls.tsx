"use client";

import { ChevronDown, ChevronUp, RotateCcw, ScanText, X } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CancelFileExtractionDocument,
  FileExtractionRunsDocument,
  RequestFileExtractionDocument,
  RetryFileExtractionDocument,
} from "@/graphql/generated/graphql";

type ExtractionRun = {
  id: string;
  state: string;
  extractor: string;
  extractorVersion: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorSummary?: unknown;
  structuredOutput?: unknown;
};

function errorMessage(result: { errors: readonly { message: string }[] }) {
  return (
    result.errors[0]?.message ||
    "The extraction request could not be completed."
  );
}

function runTimestamp(run: ExtractionRun) {
  const timestamp = run.completedAt ?? run.startedAt ?? run.createdAt;
  return new Date(timestamp).toLocaleString();
}

function safeDetails(value: unknown) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return "Details unavailable.";
  }
}

export function FileExtractionControls({
  available,
  canManage,
  fileId,
  fileName,
}: {
  available: boolean;
  canManage: boolean;
  fileId: string;
  fileName: string;
}) {
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ExtractionRun[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function refreshRuns() {
    const result = await executeBrowserGraphQL(FileExtractionRunsDocument, {
      fileId,
    });
    if (!result.ok) throw new Error(errorMessage(result));
    setRuns(
      (result.data.extractionRuns ?? []).flatMap((run) =>
        run.id &&
        run.state &&
        run.extractor &&
        run.extractorVersion &&
        run.createdAt
          ? [run as ExtractionRun]
          : [],
      ),
    );
  }

  async function perform(
    action: "request" | "cancel" | "retry",
    runId?: string,
  ) {
    const operationId = `${action}:${runId ?? fileId}`;
    setBusy(operationId);
    setStatus(null);
    try {
      const result =
        action === "request"
          ? await executeBrowserGraphQL(RequestFileExtractionDocument, {
              fileId,
            })
          : action === "cancel"
            ? await executeBrowserGraphQL(CancelFileExtractionDocument, {
                runId: runId!,
              })
            : await executeBrowserGraphQL(RetryFileExtractionDocument, {
                runId: runId!,
              });
      if (!result.ok) throw new Error(errorMessage(result));
      setStatus(
        action === "request"
          ? "Extraction requested."
          : action === "cancel"
            ? "Extraction cancelled."
            : "Extraction retry requested.",
      );
      await refreshRuns();
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : "The extraction request could not be completed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setStatus(null);
    try {
      await refreshRuns();
    } catch (error) {
      setStatus(
        error instanceof Error && error.message
          ? error.message
          : "Extraction history could not be loaded.",
      );
      setRuns([]);
    }
  }

  return (
    <div className="min-w-52">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-controls={contentId}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} extraction history for ${fileName}`}
        onClick={() => void toggle()}
      >
        <ScanText aria-hidden="true" data-icon="inline-start" />
        Extraction
        {open ? (
          <ChevronUp aria-hidden="true" />
        ) : (
          <ChevronDown aria-hidden="true" />
        )}
      </Button>
      {open ? (
        <section
          id={contentId}
          className="border-border bg-background mt-2 rounded-xl border p-3"
          aria-label={`Extraction history for ${fileName}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Extraction history</p>
            {canManage && available ? (
              <Button
                type="button"
                size="sm"
                disabled={busy !== null}
                aria-label={`Extract text from ${fileName}`}
                onClick={() => void perform("request")}
              >
                <ScanText aria-hidden="true" data-icon="inline-start" />
                {busy === `request:${fileId}` ? "Requesting…" : "Extract text"}
              </Button>
            ) : null}
          </div>
          {!available ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Extraction is available after the file passes verification.
            </p>
          ) : null}
          {runs === null ? (
            <p className="text-muted-foreground mt-2 text-xs">
              Loading extraction history…
            </p>
          ) : null}
          {runs?.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-xs">
              No extraction runs yet.
            </p>
          ) : null}
          {runs?.length ? (
            <ul className="mt-3 space-y-2" aria-label="Extraction runs">
              {runs.map((run) => {
                const active =
                  run.state === "PENDING" || run.state === "PROCESSING";
                const retryable =
                  run.state === "ERROR" || run.state === "CANCELLED";
                const details = safeDetails(
                  run.errorSummary ?? run.structuredOutput,
                );
                return (
                  <li
                    key={run.id}
                    className="border-border rounded-lg border p-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{run.state}</span>
                      <span className="text-muted-foreground">
                        {run.extractor} v{run.extractorVersion} ·{" "}
                        {runTimestamp(run)}
                      </span>
                    </div>
                    {details ? (
                      <pre className="bg-muted mt-2 overflow-x-auto rounded p-2 break-words whitespace-pre-wrap">
                        {details}
                      </pre>
                    ) : null}
                    {canManage && (active || retryable) ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {active ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy !== null}
                            aria-label={`Cancel extraction run ${run.id}`}
                            onClick={() => void perform("cancel", run.id)}
                          >
                            <X aria-hidden="true" data-icon="inline-start" />
                            {busy === `cancel:${run.id}`
                              ? "Cancelling…"
                              : "Cancel"}
                          </Button>
                        ) : null}
                        {retryable ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy !== null || !available}
                            aria-label={`Retry extraction run ${run.id}`}
                            onClick={() => void perform("retry", run.id)}
                          >
                            <RotateCcw
                              aria-hidden="true"
                              data-icon="inline-start"
                            />
                            {busy === `retry:${run.id}` ? "Retrying…" : "Retry"}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {status ? (
            <p
              className="text-muted-foreground mt-2 text-xs"
              role={status.includes("could not") ? "alert" : "status"}
            >
              {status}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
