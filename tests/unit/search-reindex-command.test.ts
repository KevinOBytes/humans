import { describe, expect, it } from "vitest";

import { parseReindexCommand } from "@/modules/search/reindex-command";

const workspaceId = "0198f25f-73fb-73ba-a524-8a33622988db";

describe("search reindex command", () => {
  it("parses the closed bounded command shape", () => {
    expect(parseReindexCommand(["--workspace", workspaceId])).toEqual({
      batchSize: 100,
      dryRun: false,
      workspaceId,
    });
    expect(
      parseReindexCommand([
        "--dry-run",
        "--batch-size",
        "500",
        "--workspace",
        workspaceId.toUpperCase(),
      ]),
    ).toEqual({ batchSize: 500, dryRun: true, workspaceId });
  });

  it.each([
    { argv: [] },
    { argv: ["--workspace"] },
    { argv: ["--workspace", "not-a-uuid"] },
    { argv: ["--workspace", workspaceId, "--workspace", workspaceId] },
    { argv: ["--workspace", workspaceId, "--batch-size", "0"] },
    { argv: ["--workspace", workspaceId, "--batch-size", "501"] },
    { argv: ["--workspace", workspaceId, "--batch-size", "1.5"] },
    { argv: ["--workspace", workspaceId, "--unknown"] },
    { argv: ["--workspace", workspaceId, "positional"] },
  ])("rejects unsafe or ambiguous argv $argv", ({ argv }) => {
    expect(() => parseReindexCommand(argv)).toThrow(TypeError);
  });
});
