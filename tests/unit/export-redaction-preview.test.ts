import { describe, expect, it, vi } from "vitest";

import { createGraphQLError } from "@/graphql/errors";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createSearchService } from "@/modules/search/service";
import {
  exportArtifactStorageKey,
  isExportArtifactRecoverable,
  previewExport,
  serializeRedactedExport,
  verifyExportCommitToken,
} from "@/modules/exports/preview";

const approval = vi.hoisted(() => ({
  bindings: [] as Record<string, unknown>[],
}));

vi.mock("@/modules/exports/approval-service", () => ({
  createExportApprovalService: () => ({
    requireApproved: async (input: Record<string, unknown>) => {
      approval.bindings.push(input);
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "Synthetic approval denial.",
      );
    },
  }),
}));

const key = "22".repeat(32);
describe("governed export previews", () => {
  it("allows deterministic retry only for interrupted artifact states", () => {
    expect(isExportArtifactRecoverable("writing")).toBe(true);
    expect(isExportArtifactRecoverable("failed")).toBe(true);
    expect(isExportArtifactRecoverable("ready")).toBe(false);
    expect(isExportArtifactRecoverable("expired")).toBe(false);
    expect(
      exportArtifactStorageKey("019cc7c4-6ed2-7e0a-aed8-e5d451c97005", "CSV"),
    ).toBe("exports/019cc7c4-6ed2-7e0a-aed8-e5d451c97005/governed-export.csv");
  });

  it("redacts fields above the requested sensitivity and requires approval", () => {
    const preview = previewExport({
      workspaceId: "w",
      actorPrincipalId: "p",
      purpose: "review",
      redactionProfile: "INTERNAL",
      rows: [
        {
          id: "1",
          sensitivity: "internal",
          values: { name: "Alice", phone: "+1" },
          fieldSensitivity: { name: "public", phone: "restricted" },
          sourceIds: ["s1"],
        },
      ],
      governanceSubjects: [
        { personId: "person-1", fieldDefinitionId: "field-1" },
      ],
      hmacKey: key,
    });
    expect(preview.rows[0].values).toEqual({ name: "Alice", phone: null });
    expect(preview.approvalRequired).toBe(true);
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.governanceSubjects).toEqual([
      { personId: "person-1", fieldDefinitionId: "field-1" },
    ]);
    expect(serializeRedactedExport(preview, "JSON")).not.toContain("+1");
  });
  it("binds export references to scope and expires them", () => {
    const preview = previewExport({
      workspaceId: "w",
      actorPrincipalId: "p",
      purpose: "review",
      redactionProfile: "PUBLIC",
      rows: [],
      hmacKey: key,
    });
    expect(
      verifyExportCommitToken({
        token: preview.commitToken,
        workspaceId: "w",
        actorPrincipalId: "p",
        purpose: "review",
        redactionProfile: "PUBLIC",
        previewHash: preview.previewHash,
        hmacKey: key,
      }),
    ).toBeInstanceOf(Date);
    expect(() =>
      verifyExportCommitToken({
        token: preview.commitToken,
        workspaceId: "w",
        actorPrincipalId: "other",
        purpose: "review",
        redactionProfile: "PUBLIC",
        previewHash: preview.previewHash,
        hmacKey: key,
      }),
    ).toThrow();
  });

  it("binds an export commit token to the exact redacted preview", () => {
    const preview = previewExport({
      workspaceId: "w",
      actorPrincipalId: "p",
      purpose: "review",
      redactionProfile: "PUBLIC",
      rows: [{ id: "1", values: { name: "Alice" } }],
      hmacKey: key,
    });

    expect(() =>
      verifyExportCommitToken({
        token: preview.commitToken,
        workspaceId: "w",
        actorPrincipalId: "p",
        purpose: "review",
        redactionProfile: "PUBLIC",
        previewHash: "0".repeat(64),
        hmacKey: key,
      }),
    ).toThrow("scope does not match");
  });

  it("changes the approval binding when governed scope changes", () => {
    const base = {
      workspaceId: "w",
      actorPrincipalId: "p",
      purpose: "review",
      redactionProfile: "CONFIDENTIAL" as const,
      rows: [{ id: "1", values: { name: "Alice" } }],
      hmacKey: key,
    };

    const preview = previewExport(base);
    expect(
      previewExport({ ...base, purpose: "different" }).previewHash,
    ).not.toBe(preview.previewHash);
    expect(previewExport({ ...base, caseId: "case" }).previewHash).not.toBe(
      preview.previewHash,
    );
    expect(
      previewExport({ ...base, rows: [{ id: "1", values: { name: "Bob" } }] })
        .previewHash,
    ).not.toBe(preview.previewHash);
  });

  it("serializes spreadsheet-looking values as inert CSV cells", () => {
    const preview = previewExport({
      workspaceId: "w",
      actorPrincipalId: "p",
      purpose: "review",
      redactionProfile: "PUBLIC",
      rows: [
        {
          id: "1",
          values: { note: '=HYPERLINK("https://bad")' },
          fieldSensitivity: { note: "public" },
        },
      ],
      hmacKey: key,
    });

    expect(serializeRedactedExport(preview, "CSV")).toContain("'=HYPERLINK");
  });

  it("requires approval against the exact deterministic governed preview", async () => {
    approval.bindings.length = 0;
    const service = createSearchService(
      {
        actor: {
          type: "user",
          id: "user",
          principalId: "principal",
          memberId: "member",
          sessionId: "session",
          role: "owner",
        },
        database: {} as never,
        idempotencyHmacKey: "33".repeat(32),
        metrics: {
          searchRequest: () => undefined,
          searchIndexMutation: () => undefined,
          searchLatency: () => undefined,
        } as never,
        operationLimiter: { consume: async () => undefined } as never,
        permissions: new Set([
          "workspace:update",
          "file:create",
          "search:read",
        ]),
        requestId: "request",
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        workspaceId: "workspace",
      },
      {
        cursorHmacKey: key,
        protectedLookupHmacKey: "44".repeat(32),
        exportArtifacts: {
          objectStore: { putInternal: async () => undefined } as never,
          storageBucket: "synthetic",
          storageProvider: "s3",
        },
      },
    );
    const preview = previewExport({
      workspaceId: "workspace",
      actorPrincipalId: "principal",
      purpose: "review",
      caseId: "case",
      redactionProfile: "CONFIDENTIAL",
      rows: [],
      hmacKey: key,
    });
    service.previewExport = async () => preview;

    await expect(
      service.commitExport({
        query: "synthetic",
        purpose: "review",
        caseId: "case",
        redactionProfile: "CONFIDENTIAL",
        first: 10,
        format: "JSON",
        commitToken: preview.commitToken,
        idempotencyKey: "commit",
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(approval.bindings).toEqual([
      {
        workspaceId: "workspace",
        actorPrincipalId: "principal",
        purpose: "review",
        caseId: "case",
        redactionProfile: "CONFIDENTIAL",
        previewHash: preview.previewHash,
        now: expect.any(Date),
      },
    ]);
  });
});
