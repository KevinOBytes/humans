import { spawnSync } from "node:child_process";

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

describe("workspace profile definition backfill process failures", () => {
  const entryPath = "src/db/backfill-workspace-profile-definitions-entry.ts";
  const arguments_ = [
    "--conditions",
    "react-server",
    "--import",
    "tsx",
    entryPath,
    "--",
    "--workspace-id",
    "018f0000-0000-7000-8000-000000000001",
    "--actor-id",
    "018f0000-0000-7000-8000-000000000002",
  ];
  const safeFailure = `${JSON.stringify({
    code: "PROFILE_DEFINITION_BACKFILL_FAILED",
    message: "Profile definition backfill failed.",
  })}\n`;

  it.each([
    {
      name: "a malformed connection URL",
      databaseUrl: "not-a-url-with-SYNTHETIC_MALFORMED_SECRET",
      secret: "SYNTHETIC_MALFORMED_SECRET",
    },
    {
      name: "a database connection failure",
      databaseUrl:
        "postgresql://profile_operator:SYNTHETIC_DATABASE_SECRET@127.0.0.1:1/humans_test?connect_timeout=1",
      secret: "SYNTHETIC_DATABASE_SECRET",
    },
  ])("fails safely for $name", ({ databaseUrl, secret }) => {
    const result = spawnSync(process.execPath, arguments_, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(safeFailure);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });
});
