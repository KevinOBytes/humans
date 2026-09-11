"use client";

type ExportPreview = Readonly<{
  purpose: string;
  caseId: string | null;
  redactionProfile: string;
  rows: readonly Readonly<{
    id: string;
    redactedFields: readonly string[];
  }>[];
  fieldCounts: Readonly<{
    visible: number;
    redacted: number;
  }>;
  approvalRequired: boolean;
  previewHash: string;
  expiresAt: string;
}>;

export function ExportPreviewPanel({
  preview,
}: {
  preview: ExportPreview | null;
}) {
  if (!preview)
    return (
      <section aria-label="Export preview">
        <p className="text-muted-foreground text-sm">
          Preview an export before issuing an expiring artifact reference.
        </p>
      </section>
    );
  return (
    <section
      aria-label="Export preview"
      className="space-y-3 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Export preview</h2>
        <span className="text-muted-foreground text-xs">
          {preview.approvalRequired ? "Approval required" : "Ready for review"}
        </span>
      </div>
      <p className="text-sm">
        {preview.fieldCounts.visible} visible field
        {preview.fieldCounts.visible === 1 ? "" : "s"};{" "}
        {preview.fieldCounts.redacted} redacted. Profile:{" "}
        {preview.redactionProfile}.
      </p>
      <p className="text-muted-foreground text-xs">
        Purpose: {preview.purpose}
        {preview.caseId ? ` · Case ${preview.caseId}` : ""} · expires{" "}
        {new Date(preview.expiresAt).toLocaleString()}
      </p>
      <p className="text-muted-foreground font-mono text-xs break-all">
        Preview fingerprint: <span>{preview.previewHash}</span>
      </p>
      <ul className="bg-muted max-h-48 overflow-auto rounded-lg p-3 text-xs">
        {preview.rows.map((row) => (
          <li key={row.id}>
            Record {row.id}:{" "}
            {row.redactedFields.length
              ? `redacted ${row.redactedFields.join(", ")}`
              : "no redactions"}
          </li>
        ))}
      </ul>
    </section>
  );
}
