import { describe, expect, it } from "vitest";
import {
  planRetentionCandidates,
  type RetentionResourceCandidate,
} from "@/modules/privacy/retention-worker";

const now = new Date("2026-09-12T00:00:00.000Z");
const policy = {
  id: "00000000-0000-7000-8000-000000000001",
  retentionDays: 30,
  deletionBehavior: "soft_delete",
};

const resource = (
  id: string,
  createdAt: string,
  held = false,
): RetentionResourceCandidate => ({
  id,
  createdAt: new Date(createdAt),
  held,
});

describe("retention worker candidate planning", () => {
  it("selects only due, unheld resources and leaves deletion for review", () => {
    expect(
      planRetentionCandidates({
        now,
        policy,
        resources: [
          resource("expired", "2026-08-01T00:00:00Z"),
          resource("held", "2026-08-01T00:00:00Z", true),
          resource("active", "2026-08-20T00:00:00Z"),
        ],
      }),
    ).toEqual([
      {
        id: "expired",
        reason: "retention_elapsed_soft_delete_requires_approval",
      },
    ]);
  });

  it("treats the exact expiry instant as due and ignores policies that cannot queue review", () => {
    expect(
      planRetentionCandidates({
        now,
        policy,
        resources: [resource("boundary", "2026-08-13T00:00:00Z")],
      }),
    ).toEqual([
      {
        id: "boundary",
        reason: "retention_elapsed_soft_delete_requires_approval",
      },
    ]);
    expect(
      planRetentionCandidates({
        now,
        policy: { ...policy, deletionBehavior: "hard_delete" },
        resources: [resource("hard-delete", "2026-08-01T00:00:00Z")],
      }),
    ).toEqual([]);
  });

  it("fails closed for invalid dates and policy intervals", () => {
    expect(() =>
      planRetentionCandidates({
        now,
        policy: { ...policy, retentionDays: -1 },
        resources: [],
      }),
    ).toThrow();
    expect(() =>
      planRetentionCandidates({
        now,
        policy,
        resources: [resource("invalid", "invalid")],
      }),
    ).toThrow();
  });
});
