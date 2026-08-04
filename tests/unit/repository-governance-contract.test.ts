import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("repository governance contract", () => {
  it("publishes license metadata and executable local policy gates", () => {
    const packageJson = JSON.parse(read("package.json"));

    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.scripts).toEqual(
      expect.objectContaining({
        "ci:contracts": expect.any(String),
        "ci:validate": expect.any(String),
        "db:drift:check": "node scripts/check-drizzle-drift.mjs",
        "deps:audit": "corepack pnpm audit --prod --audit-level high",
        "deps:licenses": "node scripts/check-dependency-licenses.mjs",
        "sbom:generate": "node scripts/run-supply-chain-tool.mjs sbom",
        "security:image": "node scripts/run-supply-chain-tool.mjs image",
        "security:secrets": "node scripts/run-supply-chain-tool.mjs secrets",
      }),
    );
    expect(read("scripts/run-supply-chain-tool.mjs")).toContain(
      'if (rawArguments[0] === "--") rawArguments.shift()',
    );
  });

  it("configures bounded Dependabot updates without credentials or Docker drift", () => {
    const config = read(".github/dependabot.yml");

    expect(config).toContain("version: 2");
    expect(config.match(/package-ecosystem:/g)).toHaveLength(2);
    expect(config).toContain('package-ecosystem: "npm"');
    expect(config).toContain('package-ecosystem: "github-actions"');
    expect(config.match(/interval: "weekly"/g)).toHaveLength(2);
    expect(config.match(/open-pull-requests-limit: 5/g)).toHaveLength(2);
    expect(config).toContain("groups:");
    expect(config).not.toMatch(
      /password|token|secret|registries:|package-ecosystem:\s*["']?docker/iu,
    );
  });

  it("provides safe contribution templates with complete review prompts", () => {
    const pullRequest = read(".github/pull_request_template.md");
    const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
    const chooser = read(".github/ISSUE_TEMPLATE/config.yml");

    for (const topic of [
      "Requirement IDs",
      "Test evidence",
      "Migration and schema impact",
      "Security and privacy impact",
      "Documentation",
      "Operations",
      "Rollback",
      "Deployment",
    ]) {
      expect(pullRequest).toContain(topic);
    }
    expect(bug).toContain("SECURITY.md");
    expect(bug).toContain("Do not include credentials or personal data");
    expect(chooser).toContain("SECURITY.md");
    expect(chooser).toContain("blank_issues_enabled: false");
    expect(chooser).toContain(
      "https://github.com/KevinOBytes/humans/blob/main/SECURITY.md",
    );
  });

  it("documents required-capable checks without claiming hosted controls exist", () => {
    const governance = read("docs/REPOSITORY_GOVERNANCE.md");
    const dependencies = read("docs/DEPENDENCY_POLICY.md");
    const requirements = read("docs/REQUIREMENTS.md");
    const todo = read("TODO.md");

    for (const check of [
      "quality",
      "generated-drift",
      "database-integration",
      "production-build",
      "compose-lifecycle",
      "dependency-policy",
      "secret-scan",
      "image-security",
    ]) {
      expect(governance).toContain(`\`${check}\``);
    }
    expect(governance).toContain("not yet verified");
    expect(governance).toContain("git ls-remote");
    expect(governance).toContain("manifest-list digest");
    expect(dependencies).toContain("fail closed");
    expect(dependencies).toContain("expiry");
    expect(requirements).toMatch(/^\| `HUM-NFR-014` .+\| Incomplete \|$/m);
    expect(requirements).toMatch(/^\| `HUM-NFR-017` .+\| Incomplete \|$/m);
    expect(todo.match(/`HUM-NFR-014`/g)).toHaveLength(1);
    expect(todo.match(/`HUM-NFR-017`/g)).toHaveLength(1);
  });

  it("does not guess ownership or leak hosted-setting claims", () => {
    expect(existsSync(".github/CODEOWNERS")).toBe(false);
    expect(existsSync("CODEOWNERS")).toBe(false);
    const publicDocs = [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "docs/REPOSITORY_GOVERNANCE.md",
    ]
      .map(read)
      .join("\n");

    expect(publicDocs).not.toMatch(
      /(?:branch protection|required checks|private vulnerability reporting|hosted secret scanning) (?:is|are|has been|have been) enabled/iu,
    );
  });

  it("allows only the independently reviewed exact historical Gitleaks fingerprints", () => {
    const ignoreLines = read(".gitleaksignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(ignoreLines).toHaveLength(25);
    for (const line of ignoreLines) {
      expect(line).toMatch(/^[a-f0-9]{40}:[^:*?\[\]{}]+:generic-api-key:\d+$/u);
    }
    expect(read("docs/REPOSITORY_GOVERNANCE.md")).toMatch(
      /no rule, path, regular-expression, or\s+wildcard suppression/u,
    );
  });

  it("keeps locally generated SBOMs out of source and image inputs", () => {
    expect(read(".gitignore")).toContain("/sbom.spdx.json");
    const dockerIgnore = read(".dockerignore");
    expect(dockerIgnore).toContain("sbom*.json");
    expect(dockerIgnore).toContain(".env.*");
    expect(dockerIgnore).not.toContain("!.env.example");
  });
});
