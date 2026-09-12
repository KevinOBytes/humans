import { afterEach, describe, expect, it, vi } from "vitest";

import { createBrowserExportApprovalAdapter } from "@/components/exports/export-approval-browser";

const approvalId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7301";
const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7302";
const previewHash = "e5".repeat(32);
const approval = {
  id: approvalId,
  workspaceId,
  purpose: "browser adapter review",
  caseId: null,
  previewHash,
  redactionProfile: "CONFIDENTIAL",
  requestedByPrincipalId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7303",
  reviewedByPrincipalId: null,
  state: "REQUESTED",
  requestReason: "Independent browser adapter review.",
  decisionReason: null,
  expiresAt: "2026-09-11T13:00:00.000Z",
  reviewedAt: null,
  version: 1,
  requestAuditReference: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7304",
  reviewAuditReference: null,
  createdAt: "2026-09-11T12:00:00.000Z",
};

afterEach(() => vi.restoreAllMocks());

describe("browser export approval adapter", () => {
  it("uses generated operations and strips exported values from the rendered preview model", async () => {
    const requests: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(request);
      if (request.query.includes("mutation PreviewExport")) {
        return new Response(
          JSON.stringify({
            data: {
              previewExport: {
                workspaceId,
                purpose: approval.purpose,
                caseId: null,
                redactionProfile: "CONFIDENTIAL",
                rows: [
                  {
                    id: "record-1",
                    redactedFields: ["phone"],
                    values: { name: "PRIVATE EXPORTED VALUE" },
                  },
                ],
                fieldCounts: { visible: 1, redacted: 1 },
                approvalRequired: true,
                previewHash,
                expiresAt: approval.expiresAt,
                commitToken: "signed-token",
                provenanceManifest: { private: "manifest" },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.query.includes("mutation RequestExportApproval"))
        return new Response(
          JSON.stringify({ data: { requestExportApproval: approval } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (request.query.includes("mutation ReviewExportApproval"))
        return new Response(
          JSON.stringify({
            data: {
              reviewExportApproval: {
                ...approval,
                state: "APPROVED",
                version: 2,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      throw new Error("Unexpected generated operation");
    });
    const adapter = createBrowserExportApprovalAdapter();
    const preview = await adapter.preview({
      query: "Alice",
      purpose: approval.purpose,
      caseId: null,
      redactionProfile: "CONFIDENTIAL",
      first: 25,
    });
    expect(preview.rows).toEqual([
      { id: "record-1", redactedFields: ["phone"] },
    ]);
    expect(JSON.stringify(preview)).not.toContain("PRIVATE EXPORTED VALUE");
    expect(JSON.stringify(preview)).not.toContain("manifest");

    await adapter.request({
      purpose: preview.purpose,
      caseId: preview.caseId,
      previewHash: preview.previewHash,
      redactionProfile: preview.redactionProfile,
      requestReason: approval.requestReason,
      expiresAt: preview.expiresAt,
      idempotencyKey: "browser-request",
    });
    await adapter.review({
      id: approvalId,
      expectedVersion: 1,
      expectedPreviewHash: preview.previewHash,
      decision: "APPROVED",
      reason: "The displayed fingerprint was reviewed.",
      idempotencyKey: "browser-review",
    });

    expect(requests.map(({ query }) => query)).toEqual([
      expect.stringContaining("mutation PreviewExport"),
      expect.stringContaining("mutation RequestExportApproval"),
      expect.stringContaining("mutation ReviewExportApproval"),
    ]);
    expect(requests[1]?.variables).toMatchObject({
      input: { previewHash },
    });
    expect(requests[2]?.variables).toMatchObject({
      input: { expectedPreviewHash: previewHash },
    });
  });
});
