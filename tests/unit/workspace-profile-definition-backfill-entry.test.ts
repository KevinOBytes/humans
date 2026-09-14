import { describe, expect, it } from "vitest";

import {
  formatWorkspaceProfileDefinitionBackfillResult,
  parseWorkspaceProfileDefinitionBackfillArgs,
} from "@/db/backfill-workspace-profile-definitions-entry";

describe("workspace profile definition backfill operator entry", () => {
  it("requires one explicit workspace and actor principal", () => {
    expect(
      parseWorkspaceProfileDefinitionBackfillArgs([
        "--",
        "--workspace-id",
        "018f0000-0000-7000-8000-000000000001",
        "--actor-id",
        "018f0000-0000-7000-8000-000000000002",
      ]),
    ).toEqual({
      workspaceId: "018f0000-0000-7000-8000-000000000001",
      actorId: "018f0000-0000-7000-8000-000000000002",
    });
    expect(() =>
      parseWorkspaceProfileDefinitionBackfillArgs([
        "--workspace-id",
        "018f0000-0000-7000-8000-000000000001",
      ]),
    ).toThrow("--actor-id");
    expect(() =>
      parseWorkspaceProfileDefinitionBackfillArgs([
        "--workspace-id",
        "all",
        "--actor-id",
        "018f0000-0000-7000-8000-000000000002",
      ]),
    ).toThrow("UUID");
  });

  it("formats only non-sensitive catalog outcome metadata", () => {
    expect(
      formatWorkspaceProfileDefinitionBackfillResult({
        inserted: [
          {
            id: "018f0000-0000-7000-8000-000000000003",
            namespace: "profile",
            fieldKey: "employment",
            version: 1,
          },
        ],
      }),
    ).toBe(
      JSON.stringify({
        catalogVersion: 1,
        insertedCount: 1,
        insertedKeys: ["profile.employment"],
      }),
    );
  });
});
