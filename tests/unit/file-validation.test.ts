import { describe, expect, it } from "vitest";

import {
  assertFileTransition,
  UPLOAD_COMPLETION_CAPACITY,
  uploadCompletionCost,
  validateUploadContent,
  validateUploadRequest,
} from "@/modules/files/validation";

const checksum = "a".repeat(64);

describe("file upload validation", () => {
  it("normalizes a safe display name and enforces purpose limits", () => {
    expect(
      validateUploadRequest({
        byteSize: 12,
        checksumSha256: checksum,
        claimedMediaType: "text/plain",
        originalName: "  report.txt  ",
        purpose: "EVIDENCE",
      }),
    ).toMatchObject({ originalName: "report.txt", byteSize: 12 });

    for (const originalName of [
      "../report.txt",
      ".hidden.txt",
      "CON.txt",
      "report. ",
      "report\u202Etxt",
      "folder/report.txt",
    ]) {
      expect(() =>
        validateUploadRequest({
          byteSize: 12,
          checksumSha256: checksum,
          claimedMediaType: "text/plain",
          originalName,
          purpose: "EVIDENCE",
        }),
      ).toThrow(/name/i);
    }

    expect(() =>
      validateUploadRequest({
        byteSize: 25 * 1024 * 1024 + 1,
        checksumSha256: checksum,
        claimedMediaType: "text/csv",
        originalName: "people.csv",
        purpose: "CSV_IMPORT",
      }),
    ).toThrow(/size/i);
    expect(() =>
      validateUploadRequest({
        byteSize: 1,
        checksumSha256: checksum.toUpperCase(),
        claimedMediaType: "text/plain",
        originalName: "report.txt",
        purpose: "EVIDENCE",
      }),
    ).toThrow(/checksum/i);
  });

  it("rejects mismatched, active, encoded, and invalid content", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);
    await expect(
      validateUploadContent({
        bytes: png,
        claimedMediaType: "image/jpeg",
        originalName: "image.jpg",
        purpose: "EVIDENCE",
      }),
    ).rejects.toThrow(/type/i);
    await expect(
      validateUploadContent({
        bytes: new TextEncoder().encode("<svg><script/></svg>"),
        claimedMediaType: "text/plain",
        originalName: "image.txt",
        purpose: "EVIDENCE",
      }),
    ).rejects.toThrow(/active|content/i);
    await expect(
      validateUploadContent({
        bytes: Uint8Array.from([0xff, 0xfe, 0x61, 0]),
        claimedMediaType: "text/plain",
        originalName: "bad.txt",
        purpose: "EVIDENCE",
      }),
    ).rejects.toThrow(/utf/i);
  });

  it("keeps file lifecycle transitions closed", () => {
    expect(() =>
      assertFileTransition("quarantined", "available", "not_required"),
    ).not.toThrow();
    expect(() =>
      assertFileTransition("quarantined", "available", "error"),
    ).toThrow(/scan/i);
    expect(() =>
      assertFileTransition("available", "quarantined", "clean"),
    ).toThrow(/transition/i);
  });

  it.each([
    [20, 20],
    [21, 21],
    [25, 25],
    [50, 50],
  ])("admits a valid %i MiB upload with completion cost %i", (mib, cost) => {
    expect(uploadCompletionCost(mib * 1024 * 1024)).toBe(cost);
    expect(cost).toBeLessThanOrEqual(UPLOAD_COMPLETION_CAPACITY);
  });
});
