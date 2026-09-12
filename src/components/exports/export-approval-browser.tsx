"use client";

import { useMemo } from "react";

import { executeBrowserGraphQL } from "@/graphql/client";
import {
  CommitExportDocument,
  PreviewExportDocument,
  RequestExportApprovalDocument,
  ReviewExportApprovalDocument,
  type PendingExportApprovalsQuery,
} from "@/graphql/generated/graphql";

import {
  ExportApprovalWorkflow,
  type ExportApprovalWorkflowAdapter,
  type GovernedExportPreview,
  type PendingExportApproval,
} from "./export-approval-workflow";

type ApprovalRow =
  PendingExportApprovalsQuery["pendingExportApprovals"][number];

class ExportApprovalRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The governed export request could not be completed.");
    this.name = "ExportApprovalRequestError";
    this.code = code;
  }
}

function failed(errors: readonly { code: string }[]): never {
  throw new ExportApprovalRequestError(errors[0]?.code ?? "INTERNAL");
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined)
    throw new ExportApprovalRequestError(`INVALID_RESPONSE_${field}`);
  return value;
}

function profile(value: unknown): PendingExportApproval["redactionProfile"] {
  if (
    value !== "PUBLIC" &&
    value !== "INTERNAL" &&
    value !== "CONFIDENTIAL" &&
    value !== "RESTRICTED"
  )
    throw new ExportApprovalRequestError("INVALID_RESPONSE_PROFILE");
  return value;
}

function state(value: unknown): PendingExportApproval["state"] {
  if (value !== "REQUESTED" && value !== "APPROVED" && value !== "REJECTED")
    throw new ExportApprovalRequestError("INVALID_RESPONSE_STATE");
  return value;
}

function approval(
  value: ApprovalRow | null | undefined,
): PendingExportApproval {
  const row = required(value, "APPROVAL");
  return {
    id: required(row.id, "APPROVAL_ID"),
    workspaceId: required(row.workspaceId, "APPROVAL_WORKSPACE"),
    caseId: row.caseId ?? null,
    purpose: required(row.purpose, "APPROVAL_PURPOSE"),
    previewHash: required(row.previewHash, "APPROVAL_PREVIEW_HASH"),
    redactionProfile: profile(row.redactionProfile),
    requestedByPrincipalId: required(
      row.requestedByPrincipalId,
      "APPROVAL_REQUESTER",
    ),
    reviewedByPrincipalId: row.reviewedByPrincipalId ?? null,
    state: state(row.state),
    requestReason: required(row.requestReason, "APPROVAL_REQUEST_REASON"),
    decisionReason: row.decisionReason ?? null,
    expiresAt: required(row.expiresAt, "APPROVAL_EXPIRY"),
    reviewedAt: row.reviewedAt ?? null,
    requestAuditReference: required(
      row.requestAuditReference,
      "APPROVAL_REQUEST_AUDIT",
    ),
    reviewAuditReference: row.reviewAuditReference ?? null,
    version: required(row.version, "APPROVAL_VERSION"),
    createdAt: required(row.createdAt, "APPROVAL_CREATED_AT"),
  };
}

function previewRows(value: unknown): GovernedExportPreview["rows"] {
  if (!Array.isArray(value))
    throw new ExportApprovalRequestError("INVALID_RESPONSE_PREVIEW_ROWS");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ExportApprovalRequestError(
        `INVALID_RESPONSE_PREVIEW_ROW_${index}`,
      );
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !Array.isArray(row.redactedFields) ||
      row.redactedFields.some((field) => typeof field !== "string")
    )
      throw new ExportApprovalRequestError(
        `INVALID_RESPONSE_PREVIEW_ROW_${index}`,
      );
    return { id: row.id, redactedFields: row.redactedFields as string[] };
  });
}

function fieldCounts(value: unknown): GovernedExportPreview["fieldCounts"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ExportApprovalRequestError("INVALID_RESPONSE_FIELD_COUNTS");
  const counts = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(counts.visible) ||
    !Number.isSafeInteger(counts.redacted)
  )
    throw new ExportApprovalRequestError("INVALID_RESPONSE_FIELD_COUNTS");
  return {
    visible: counts.visible as number,
    redacted: counts.redacted as number,
  };
}

export function createBrowserExportApprovalAdapter(): ExportApprovalWorkflowAdapter {
  return {
    async preview(input) {
      const response = await executeBrowserGraphQL(PreviewExportDocument, {
        input,
      });
      if (!response.ok) return failed(response.errors);
      const value = required(response.data.previewExport, "PREVIEW");
      return {
        purpose: required(value.purpose, "PREVIEW_PURPOSE"),
        caseId: value.caseId ?? null,
        redactionProfile: profile(value.redactionProfile),
        rows: previewRows(value.rows),
        fieldCounts: fieldCounts(value.fieldCounts),
        approvalRequired: required(
          value.approvalRequired,
          "PREVIEW_APPROVAL_REQUIRED",
        ),
        previewHash: required(value.previewHash, "PREVIEW_HASH"),
        expiresAt: required(value.expiresAt, "PREVIEW_EXPIRY"),
        commitToken: required(value.commitToken, "PREVIEW_TOKEN"),
      };
    },
    async request(input) {
      const response = await executeBrowserGraphQL(
        RequestExportApprovalDocument,
        { input },
      );
      if (!response.ok) return failed(response.errors);
      return approval(response.data.requestExportApproval);
    },
    async review(input) {
      const response = await executeBrowserGraphQL(
        ReviewExportApprovalDocument,
        {
          input,
        },
      );
      if (!response.ok) return failed(response.errors);
      return approval(response.data.reviewExportApproval);
    },
    async commit(input) {
      const response = await executeBrowserGraphQL(CommitExportDocument, {
        input,
      });
      if (!response.ok) return failed(response.errors);
      return required(response.data.commitExport, "COMMIT");
    },
  };
}

export function BrowserExportApprovalWorkflow(props: {
  canRequest: boolean;
  pendingApprovals: readonly ApprovalRow[];
  workspaceIdentity: string;
}) {
  const adapter = useMemo(() => createBrowserExportApprovalAdapter(), []);
  const pendingApprovals = useMemo(
    () => props.pendingApprovals.map(approval),
    [props.pendingApprovals],
  );
  return (
    <ExportApprovalWorkflow
      adapter={adapter}
      canRequest={props.canRequest}
      pendingApprovals={pendingApprovals}
      workspaceIdentity={props.workspaceIdentity}
    />
  );
}
