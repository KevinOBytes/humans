import { describe, expect, it } from "vitest";
import {
  planRetentionCandidates,
  retentionPolicyMatchesSnapshot,
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
  it("accepts only an unchanged, active policy snapshot", () => {
    const snapshot = {
      id: policy.id,
      version: 1,
      resourceKind: "person",
      retentionDays: policy.retentionDays,
      deletionBehavior: policy.deletionBehavior,
      deletedAt: null,
    } as const;

    expect(retentionPolicyMatchesSnapshot(snapshot, { ...snapshot })).toBe(
      true,
    );
    expect(
      retentionPolicyMatchesSnapshot(snapshot, { ...snapshot, version: 2 }),
    ).toBe(false);
    expect(
      retentionPolicyMatchesSnapshot(snapshot, {
        ...snapshot,
        deletionBehavior: "review",
      }),
    ).toBe(false);
    expect(
      retentionPolicyMatchesSnapshot(snapshot, {
        ...snapshot,
        retentionDays: 31,
      }),
    ).toBe(false);
    expect(
      retentionPolicyMatchesSnapshot(snapshot, {
        ...snapshot,
        deletedAt: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

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
