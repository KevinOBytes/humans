"use client";

import type { AnalysisResult } from "@/modules/search/analysis";

export function AnalysisPanel({ result }: { result: AnalysisResult | null }) {
  if (!result)
    return (
      <section aria-label="Research analysis">
        <p className="text-muted-foreground text-sm">
          Run a bounded analysis to review timeline, source, duplicate,
          contradiction, or graph metrics.
        </p>
      </section>
    );
  return (
    <section
      aria-label="Research analysis"
      className="space-y-3 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{result.kind.replaceAll("_", " ")}</h2>
        <span className="text-muted-foreground text-xs">
          {result.redactedFieldCount} redacted field
          {result.redactedFieldCount === 1 ? "" : "s"}
        </span>
      </div>
      <p className="text-muted-foreground text-sm">
        {result.explanation.methodology}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Rows considered</dt>
          <dd>{result.explanation.sourceRows}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Rows returned</dt>
          <dd>{result.explanation.returnedRows}</dd>
        </div>
      </dl>
      {result.explanation.omittedFields.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Restricted fields are omitted from this view:{" "}
          {result.explanation.omittedFields.join(", ")}.
        </p>
      )}
      <pre className="bg-muted max-h-72 overflow-auto rounded-lg p-3 text-xs">
        {JSON.stringify(result.rows, null, 2)}
      </pre>
    </section>
  );
}
