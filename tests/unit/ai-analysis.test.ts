import { describe, expect, it } from "vitest";

import {
  decodeAiRunHistoryCursor,
  encodeAiRunHistoryCursor,
} from "@/modules/ai/repository-domain";
import { normalizeAiRunHistoryPage } from "@/modules/ai/service";

const hmacKey = "ab".repeat(32);
const binding = {
  principalId: "018f0000-0000-7000-8000-000000000002",
  workspaceId: "018f0000-0000-7000-8000-000000000001",
} as const;

describe("AI analysis history cursor", () => {
  it("contains only its versioned created-at and ID position", () => {
    const cursor = encodeAiRunHistoryCursor(
      {
        createdAt: new Date("2026-08-04T12:00:00.000Z"),
        id: "018f0000-0000-7000-8000-000000000003",
      },
      binding,
      hmacKey,
    );
    const [body] = cursor.split(".");

    expect(
      JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")),
    ).toEqual({
      v: 1,
      createdAt: "2026-08-04T12:00:00.000Z",
      id: "018f0000-0000-7000-8000-000000000003",
    });
    expect(decodeAiRunHistoryCursor(cursor, binding, hmacKey)).toEqual({
      createdAt: new Date("2026-08-04T12:00:00.000Z"),
      id: "018f0000-0000-7000-8000-000000000003",
    });
  });

  it("rejects tampering and reuse by another principal or workspace", () => {
    const cursor = encodeAiRunHistoryCursor(
      {
        createdAt: new Date("2026-08-04T12:00:00.000Z"),
        id: "018f0000-0000-7000-8000-000000000003",
      },
      binding,
      hmacKey,
    );

    expect(() =>
      decodeAiRunHistoryCursor(
        `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`,
        binding,
        hmacKey,
      ),
    ).toThrow("Invalid AI history cursor");
    expect(() =>
      decodeAiRunHistoryCursor(
        cursor,
        {
          ...binding,
          principalId: "018f0000-0000-7000-8000-000000000004",
        },
        hmacKey,
      ),
    ).toThrow("Invalid AI history cursor");
    expect(() =>
      decodeAiRunHistoryCursor(
        cursor,
        {
          ...binding,
          workspaceId: "018f0000-0000-7000-8000-000000000005",
        },
        hmacKey,
      ),
    ).toThrow("Invalid AI history cursor");
  });
});

describe("AI analysis history pagination", () => {
  it("defaults to five and accepts only the fixed one-to-ten bound", () => {
    expect(normalizeAiRunHistoryPage({})).toEqual({ after: null, first: 5 });
    expect(normalizeAiRunHistoryPage({ first: 1 })).toEqual({
      after: null,
      first: 1,
    });
    expect(normalizeAiRunHistoryPage({ first: 10 })).toEqual({
      after: null,
      first: 10,
    });

    for (const first of [0, -1, 11, 1.5]) {
      expect(() => normalizeAiRunHistoryPage({ first })).toThrow(
        "first must be between 1 and 10.",
      );
    }
  });
});
