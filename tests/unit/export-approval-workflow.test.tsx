import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ExportApprovalWorkflow,
  type ExportApprovalWorkflowAdapter,
  type PendingExportApproval,
} from "@/components/exports/export-approval-workflow";

const approvalId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7101";
const caseId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7102";
const previewHash = "a1".repeat(32);
const preview = {
  purpose: "case review",
  caseId,
  redactionProfile: "CONFIDENTIAL" as const,
  rows: [{ id: "record-1", redactedFields: ["phone"] }],
  fieldCounts: { visible: 2, redacted: 1 },
  approvalRequired: true,
  previewHash,
  expiresAt: "2026-09-11T13:00:00.000Z",
  commitToken: "signed-preview-token",
};
const pending = {
  id: approvalId,
  workspaceId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7100",
  purpose: preview.purpose,
  caseId,
  previewHash,
  redactionProfile: "CONFIDENTIAL" as const,
  requestedByPrincipalId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7103",
  reviewedByPrincipalId: null,
  state: "REQUESTED" as const,
  requestReason: "Independent release review is required.",
  decisionReason: null,
  expiresAt: preview.expiresAt,
  reviewedAt: null,
  version: 1,
  requestAuditReference: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7104",
  reviewAuditReference: null,
  createdAt: "2026-09-11T12:00:00.000Z",
};

function adapter(
  overrides: Partial<ExportApprovalWorkflowAdapter> = {},
): ExportApprovalWorkflowAdapter {
  return {
    preview: vi.fn().mockResolvedValue(preview),
    request: vi.fn().mockResolvedValue(pending),
    review: vi
      .fn()
      .mockResolvedValue({ ...pending, state: "APPROVED", version: 2 }),
    commit: vi.fn().mockRejectedValue(
      Object.assign(new Error("approval missing"), {
        code: "PRECONDITION_FAILED",
      }),
    ),
    ...overrides,
  };
}

describe("ExportApprovalWorkflow", () => {
  it("carries the exact deterministic preview hash into the request and fails closed on commit", async () => {
    const user = userEvent.setup();
    const request = vi.fn().mockResolvedValue(pending);
    const commit = vi.fn().mockRejectedValue(
      Object.assign(new Error("approval missing"), {
        code: "PRECONDITION_FAILED",
      }),
    );
    render(
      <ExportApprovalWorkflow
        adapter={adapter({ request, commit })}
        canRequest
        pendingApprovals={[]}
        workspaceIdentity="workspace-a"
      />,
    );

    await user.type(screen.getByLabelText("Export query"), "Alice");
    await user.type(screen.getByLabelText("Export purpose"), preview.purpose);
    await user.type(screen.getByLabelText("Export case ID"), caseId);
    await user.selectOptions(
      screen.getByLabelText("Export redaction profile"),
      "CONFIDENTIAL",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview governed export" }),
    );
    expect(await screen.findByText(previewHash)).toBeVisible();

    await user.type(
      screen.getByLabelText("Approval request reason"),
      pending.requestReason,
    );
    await user.click(
      screen.getByRole("button", { name: "Request independent approval" }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: preview.purpose,
        caseId,
        previewHash,
        redactionProfile: "CONFIDENTIAL",
        expiresAt: preview.expiresAt,
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Commit governed export" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A current independent approval is still required",
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "Alice",
        purpose: preview.purpose,
        caseId,
        redactionProfile: "CONFIDENTIAL",
        commitToken: preview.commitToken,
      }),
    );
  });

  it("renders only pending approval metadata and binds review to the displayed preview hash", async () => {
    const user = userEvent.setup();
    const review = vi
      .fn()
      .mockResolvedValue({ ...pending, state: "APPROVED", version: 2 });
    const withForbiddenValue = {
      ...pending,
      exportedValues: "PRIVATE EXPORTED VALUE",
    } as PendingExportApproval & { exportedValues: string };
    render(
      <ExportApprovalWorkflow
        adapter={adapter({ review })}
        canRequest={false}
        pendingApprovals={[withForbiddenValue]}
        workspaceIdentity="workspace-a"
      />,
    );

    const queue = screen.getByRole("region", {
      name: "Pending export approvals",
    });
    expect(queue).toHaveTextContent(preview.purpose);
    expect(queue).toHaveTextContent(caseId);
    expect(queue).toHaveTextContent(previewHash);
    expect(queue).toHaveTextContent(pending.requestReason);
    expect(queue).not.toHaveTextContent("PRIVATE EXPORTED VALUE");
    expect(queue).not.toHaveTextContent("record-1");

    await user.type(
      screen.getByLabelText(`Review reason for ${approvalId}`),
      "The displayed scope and redaction were reviewed.",
    );
    await user.click(
      screen.getByRole("button", { name: `Approve ${approvalId}` }),
    );
    expect(review).toHaveBeenCalledWith({
      id: approvalId,
      expectedVersion: 1,
      expectedPreviewHash: previewHash,
      decision: "APPROVED",
      reason: "The displayed scope and redaction were reviewed.",
      idempotencyKey: expect.any(String),
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Export approval recorded",
    );
    expect(
      screen.queryByRole("button", { name: `Approve ${approvalId}` }),
    ).toBeNull();
  });
});
