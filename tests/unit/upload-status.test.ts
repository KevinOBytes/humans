import { describe, expect, it } from "vitest";

import { completedUploadStatus } from "@/components/files/upload-status";

describe("upload completion status", () => {
  it("claims availability only after a clean or unnecessary scan", () => {
    expect(
      completedUploadStatus({
        availability: "AVAILABLE",
        originalName: "people.csv",
        scanState: "CLEAN",
      }),
    ).toBe("people.csv is verified and available.");
    expect(
      completedUploadStatus({
        availability: "QUARANTINED",
        originalName: "people.csv",
        scanState: "ERROR",
      }),
    ).toMatch(/quarantined.*scanning is unavailable/i);
    expect(
      completedUploadStatus({
        availability: "REJECTED",
        originalName: "people.csv",
        scanState: "INFECTED",
      }),
    ).toMatch(/rejected/i);
  });
});
