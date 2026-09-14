import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const requiredSuites = [
  "tests/integration/auth-security.test.ts",
  "tests/integration/api-key-lifecycle.test.ts",
  "tests/integration/workspace-member-administration.test.ts",
  "tests/integration/governance-lifecycle.test.ts",
  "tests/integration/governance-api.test.ts",
  "tests/integration/cases-api.test.ts",
  "tests/integration/graphql-case-idempotency.test.ts",
  "tests/integration/break-glass-access.test.ts",
];

function databaseIntegrationJob(workflow: string): string {
  const match = workflow.match(
    /^  database-integration:\n(?<body>(?: {4}.*(?:\n|$)|\s*\n)+)/m,
  );

  if (!match?.groups?.body) {
    throw new Error("Missing database-integration workflow job");
  }

  return match.groups.body;
}

describe("security and governance CI contract", () => {
  it("requires every security and governance integration suite in the database job", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const securityScript = packageJson.scripts?.["test:db:security"];

    expect(
      securityScript,
      "package.json must define test:db:security",
    ).toBeDefined();

    for (const suite of requiredSuites) {
      expect(
        securityScript,
        `test:db:security must include ${suite}`,
      ).toContain(suite);
    }
    expect(securityScript).toContain("--no-file-parallelism");

    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const databaseJob = databaseIntegrationJob(workflow);

    expect(databaseJob).toContain("corepack pnpm test:db:security");
  });
});
