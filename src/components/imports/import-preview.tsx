"use client";

type ImportPreview = Readonly<{
  purpose: string;
  caseId: string | null;
  expiresAt: string;
  issues: readonly Readonly<{ code: string; message: string }>[];
  rows: readonly Readonly<{
    rowNumber: number;
    externalKey: string | null;
    issues: readonly Readonly<{ code: string; message: string }>[];
  }>[];
}>;

export function ImportPreviewPanel({
  preview,
}: {
  preview: ImportPreview | null;
}) {
  if (!preview)
    return (
      <section aria-label="Import preview">
        <p className="text-muted-foreground text-sm">
          Select a permitted CSV, JSON, or document source to preview its
          mapping.
        </p>
      </section>
    );
  const issueCount =
    preview.issues.length +
    preview.rows.reduce((sum, row) => sum + row.issues.length, 0);
  return (
    <section
      aria-label="Import preview"
      className="space-y-3 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Import preview</h2>
        <span className="text-muted-foreground text-xs">
          Expires {new Date(preview.expiresAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm">
        {preview.rows.length} row{preview.rows.length === 1 ? "" : "s"} mapped;{" "}
        {issueCount} issue{issueCount === 1 ? "" : "s"}. Possible duplicates are
        flagged only and never merged automatically.
      </p>
      <p className="text-muted-foreground text-xs">
        Purpose: {preview.purpose}
        {preview.caseId ? ` · Case ${preview.caseId}` : ""}
      </p>
      <div className="bg-muted max-h-72 overflow-auto rounded-lg p-3 text-xs">
        {preview.rows.map((row) => (
          <div key={row.rowNumber} className="border-b py-2 last:border-0">
            <div>
              Row {row.rowNumber}: {row.externalKey ?? "no external key"}
            </div>
            {row.issues.map((issue) => (
              <div
                key={`${row.rowNumber}-${issue.code}`}
                className="text-amber-700"
              >
                {issue.message}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
