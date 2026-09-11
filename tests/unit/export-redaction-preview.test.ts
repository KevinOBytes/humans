import { describe, expect, it } from "vitest";

import {
  exportArtifactStorageKey,
  isExportArtifactRecoverable,
  previewExport,
  serializeRedactedExport,
  verifyExportCommitToken,
} from "@/modules/exports/preview";

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
});
