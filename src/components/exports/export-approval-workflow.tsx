"use client";

import { useState, type FormEvent } from "react";

import { ExportPreviewPanel } from "@/components/exports/export-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RedactionProfile = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

export type GovernedExportPreview = Readonly<{
  purpose: string;
  caseId: string | null;
  redactionProfile: RedactionProfile;
  rows: readonly Readonly<{
    id: string;
    redactedFields: readonly string[];
  }>[];
  fieldCounts: Readonly<{ visible: number; redacted: number }>;
  approvalRequired: boolean;
  previewHash: string;
  expiresAt: string;
  commitToken: string;
}>;

export type PendingExportApproval = Readonly<{
  id: string;
  workspaceId: string;
  caseId: string | null;
  purpose: string;
  previewHash: string;
  redactionProfile: RedactionProfile;
  requestedByPrincipalId: string;
  reviewedByPrincipalId: string | null;
  state: "REQUESTED" | "APPROVED" | "REJECTED";
  requestReason: string;
  decisionReason: string | null;
  expiresAt: string;
  reviewedAt: string | null;
  requestAuditReference: string;
  reviewAuditReference: string | null;
  version: number;
  createdAt: string;
}>;

export type ExportApprovalWorkflowAdapter = Readonly<{
  preview(input: {
    query: string;
    purpose: string;
    caseId: string | null;
    redactionProfile: RedactionProfile;
    first: number;
  }): Promise<GovernedExportPreview>;
  request(input: {
    purpose: string;
    caseId: string | null;
    previewHash: string;
    redactionProfile: RedactionProfile;
    requestReason: string;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<PendingExportApproval>;
  review(input: {
    id: string;
    expectedVersion: number;
    expectedPreviewHash: string;
    decision: "APPROVED" | "REJECTED";
    reason: string;
    idempotencyKey: string;
  }): Promise<PendingExportApproval>;
  commit(input: {
    query: string;
    purpose: string;
    caseId: string | null;
    redactionProfile: RedactionProfile;
    first: number;
    format: "JSON" | "CSV";
    commitToken: string;
    idempotencyKey: string;
  }): Promise<unknown>;
}>;

function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

function safeFailure(error: unknown): string {
  if (errorCode(error) === "PRECONDITION_FAILED")
    return "A current independent approval is still required. Refresh the queue after review and try again.";
  if (errorCode(error) === "FORBIDDEN")
    return "Your current role cannot complete this approval action.";
  if (errorCode(error) === "CONFLICT")
    return "This approval changed. Refresh the page before reviewing it.";
  return "The governed export action could not be completed.";
}

export function ExportApprovalWorkflow(props: {
  adapter: ExportApprovalWorkflowAdapter;
  canRequest: boolean;
  pendingApprovals: readonly PendingExportApproval[];
  workspaceIdentity: string;
}) {
  return (
    <ExportApprovalWorkflowState key={props.workspaceIdentity} {...props} />
  );
}

function ExportApprovalWorkflowState({
  adapter,
  canRequest,
  pendingApprovals: initialPending,
}: Parameters<typeof ExportApprovalWorkflow>[0]) {
  const [query, setQuery] = useState("");
  const [purpose, setPurpose] = useState("");
  const [caseId, setCaseId] = useState("");
  const [profile, setProfile] = useState<RedactionProfile>("CONFIDENTIAL");
  const [format, setFormat] = useState<"JSON" | "CSV">("JSON");
  const [requestReason, setRequestReason] = useState("");
  const [preview, setPreview] = useState<GovernedExportPreview | null>(null);
  const [pending, setPending] =
    useState<readonly PendingExportApproval[]>(initialPending);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const scope = () => ({
    query: query.trim(),
    purpose: purpose.trim(),
    caseId: caseId.trim() || null,
    redactionProfile: profile,
    first: 25,
  });

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await action();
    } catch (error) {
      setStatus(safeFailure(error));
    } finally {
      setBusy(false);
    }
  }

  function previewExport(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const next = await adapter.preview(scope());
      setPreview(next);
      setStatus(
        next.approvalRequired
          ? "Preview ready. Independent approval is required."
          : "Preview ready for commit.",
      );
    });
  }

  function requestApproval() {
    if (!preview) return;
    void run(async () => {
      const created = await adapter.request({
        purpose: preview.purpose,
        caseId: preview.caseId,
        previewHash: preview.previewHash,
        redactionProfile: preview.redactionProfile,
        requestReason: requestReason.trim(),
        expiresAt: preview.expiresAt,
        idempotencyKey: idempotencyKey("export-approval-request"),
      });
      setStatus(`Approval requested: ${created.id}.`);
    });
  }

  function commitExport() {
    if (!preview) return;
    void run(async () => {
      await adapter.commit({
        ...scope(),
        purpose: preview.purpose,
        caseId: preview.caseId,
        redactionProfile: preview.redactionProfile,
        format,
        commitToken: preview.commitToken,
        idempotencyKey: idempotencyKey("export-commit"),
      });
      setStatus("Governed export committed.");
    });
  }

  function reviewApproval(
    approval: PendingExportApproval,
    decision: "APPROVED" | "REJECTED",
  ) {
    void run(async () => {
      await adapter.review({
        id: approval.id,
        expectedVersion: approval.version,
        expectedPreviewHash: approval.previewHash,
        decision,
        reason: (reviewReasons[approval.id] ?? "").trim(),
        idempotencyKey: idempotencyKey("export-approval-review"),
      });
      setPending((current) =>
        current.filter((item) => item.id !== approval.id),
      );
      setStatus("Export approval recorded.");
    });
  }

  return (
    <div className="space-y-6">
      {canRequest ? (
        <section
          aria-labelledby="governed-export-heading"
          className="space-y-4"
        >
          <div>
            <h2 id="governed-export-heading" className="text-xl font-semibold">
              Governed export
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Preview redaction before requesting independent release approval.
            </p>
          </div>
          <form onSubmit={previewExport} className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label htmlFor="export-query">Export query</Label>
              <Input
                id="export-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="export-purpose">Export purpose</Label>
              <Input
                id="export-purpose"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="export-case">Export case ID</Label>
              <Input
                id="export-case"
                value={caseId}
                onChange={(event) => setCaseId(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="export-profile">Export redaction profile</Label>
              <select
                id="export-profile"
                className="border-input bg-background mt-2 min-h-10 w-full rounded-md border px-3 text-sm"
                value={profile}
                onChange={(event) =>
                  setProfile(event.target.value as RedactionProfile)
                }
              >
                {["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"].map(
                  (value) => (
                    <option key={value}>{value}</option>
                  ),
                )}
              </select>
            </div>
            <div>
              <Label htmlFor="export-format">Export format</Label>
              <select
                id="export-format"
                className="border-input bg-background mt-2 min-h-10 w-full rounded-md border px-3 text-sm"
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value as "JSON" | "CSV")
                }
              >
                <option>JSON</option>
                <option>CSV</option>
              </select>
            </div>
            <Button type="submit" disabled={busy}>
              Preview governed export
            </Button>
          </form>
          <ExportPreviewPanel preview={preview} />
          {preview?.approvalRequired ? (
            <div className="space-y-3">
              <Label htmlFor="export-request-reason">
                Approval request reason
              </Label>
              <Input
                id="export-request-reason"
                value={requestReason}
                onChange={(event) => setRequestReason(event.target.value)}
                required
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy || !requestReason.trim()}
                  onClick={requestApproval}
                >
                  Request independent approval
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={commitExport}
                >
                  Commit governed export
                </Button>
              </div>
            </div>
          ) : preview ? (
            <Button type="button" disabled={busy} onClick={commitExport}>
              Commit governed export
            </Button>
          ) : null}
        </section>
      ) : null}

      <section
        aria-label="Pending export approvals"
        className="space-y-4 border-t pt-6"
      >
        <div>
          <h2 className="text-xl font-semibold">Pending export approvals</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Only requests your current workspace or active-case role can review
            are shown. Exported values are never included.
          </p>
        </div>
        {pending.length ? (
          <ul className="space-y-4">
            {pending.map((approval) => (
              <li key={approval.id} className="space-y-3 rounded-xl border p-4">
                <p className="font-medium">{approval.purpose}</p>
                <p className="text-muted-foreground text-xs">
                  Request {approval.id} · requester{" "}
                  {approval.requestedByPrincipalId}
                  {approval.caseId
                    ? ` · case ${approval.caseId}`
                    : " · workspace"}
                </p>
                <p className="text-sm">{approval.requestReason}</p>
                <p className="text-muted-foreground font-mono text-xs break-all">
                  Preview fingerprint: {approval.previewHash}
                </p>
                <p className="text-muted-foreground text-xs">
                  Profile {approval.redactionProfile} · expires{" "}
                  {new Date(approval.expiresAt).toLocaleString()}
                </p>
                <Label htmlFor={`review-${approval.id}`}>
                  Review reason for {approval.id}
                </Label>
                <Input
                  id={`review-${approval.id}`}
                  value={reviewReasons[approval.id] ?? ""}
                  onChange={(event) =>
                    setReviewReasons((current) => ({
                      ...current,
                      [approval.id]: event.target.value,
                    }))
                  }
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy || !reviewReasons[approval.id]?.trim()}
                    onClick={() => reviewApproval(approval, "APPROVED")}
                    aria-label={`Approve ${approval.id}`}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !reviewReasons[approval.id]?.trim()}
                    onClick={() => reviewApproval(approval, "REJECTED")}
                    aria-label={`Reject ${approval.id}`}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            No pending export approvals are currently assigned to you.
          </p>
        )}
      </section>
      {status ? (
        <p role="status" aria-live="polite" className="text-sm">
          {status}
        </p>
      ) : null}
    </div>
  );
}
