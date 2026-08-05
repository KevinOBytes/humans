import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/ci.yml";

const officialActions = new Map([
  [
    "actions/checkout",
    { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", tag: "v7.0.1" },
  ],
  [
    "actions/setup-node",
    { sha: "820762786026740c76f36085b0efc47a31fe5020", tag: "v7.0.0" },
  ],
  [
    "pnpm/action-setup",
    { sha: "0ebf47130e4866e96fce0953f49152a61190b271", tag: "v6.0.9" },
  ],
  [
    "actions/upload-artifact",
    {
      sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      tag: "v7.0.1",
    },
  ],
  [
    "actions/dependency-review-action",
    {
      sha: "a1d282b36b6f3519aa1f3fc636f609c47dddb294",
      tag: "v5.0.0",
    },
  ],
  [
    "gitleaks/gitleaks-action",
    { sha: "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e", tag: "v3.0.0" },
  ],
  [
    "docker/setup-buildx-action",
    {
      sha: "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
      tag: "v4.2.0",
    },
  ],
  [
    "docker/build-push-action",
    {
      sha: "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
      tag: "v7.3.0",
    },
  ],
  [
    "aquasecurity/trivy-action",
    { sha: "ed142fd0673e97e23eac54620cfb913e5ce36c25", tag: "v0.36.0" },
  ],
  [
    "anchore/sbom-action",
    { sha: "e22c389904149dbc22b58101806040fa8d37a610", tag: "v0.24.0" },
  ],
]);

const readWorkflow = () => readFileSync(workflowPath, "utf8");

function jobBlock(source: string, job: string): string {
  const match = source.match(
    new RegExp(`^  ${job}:\\n(?<body>(?: {4}.*(?:\\n|$)|\\s*\\n)+)`, "m"),
  );
  if (!match?.groups?.body) throw new Error(`Missing workflow job: ${job}`);
  return match.groups.body;
}

describe("CI workflow contract", () => {
  it("uses only immutable, officially resolved action pins with release comments", () => {
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readWorkflow();
    const usesLines = workflow
      .split("\n")
      .filter((line) => /^\s*-?\s*uses:/u.test(line));

    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      const match = line.match(
        /uses:\s+([^@\s]+)@([a-f0-9]{40})\s+#\s+(v?\d+\.\d+\.\d+)\s*$/u,
      );
      expect(match, `unsafe action reference: ${line}`).not.toBeNull();
      const [, action, sha, tag] = match!;
      expect(
        officialActions.get(action),
        `unexpected action: ${action}`,
      ).toEqual({
        sha,
        tag,
      });
    }
  });

  it("uses safe events, read-only permissions, cancellation, and bounded jobs", () => {
    const workflow = readWorkflow();

    expect(workflow).toMatch(
      /^on:\n  push:\n    branches:\n      - main\n  pull_request:\n  workflow_dispatch:\s*$/m,
    );
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toMatch(/\b(?:write-all|[a-z-]+:\s*write)\b/u);
    expect(workflow).not.toContain("secrets.");
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(workflow).toMatch(
      /concurrency:\n  group: .+\n  cancel-in-progress: true/u,
    );

    for (const job of [
      "quality",
      "generated-drift",
      "database-integration",
      "production-build",
      "compose-lifecycle",
      "dependency-policy",
      "secret-scan",
      "image-security",
    ]) {
      const block = jobBlock(workflow, job);
      expect(block, `${job} must have a job timeout`).toMatch(
        /^    timeout-minutes: \d+$/m,
      );
      const checkoutStep = block.match(
        /      - name: Check out[^\n]*\n((?: {8}.*\n| {10}.*\n)+)/u,
      )?.[1];
      expect(checkoutStep, `${job} must have a checkout step`).toBeDefined();
      expect(checkoutStep, `${job} must use pinned checkout`).toMatch(
        /uses: actions\/checkout@[a-f0-9]{40}/u,
      );
      expect(
        checkoutStep,
        `${job} must persist no checkout credentials`,
      ).toContain("persist-credentials: false");
    }
  });

  it("pins the exact runtime and runs every mandatory non-optional gate", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("version: 11.11.0");
    expect(workflow).toContain("node-version: 24");
    expect(
      workflow.match(/corepack pnpm install --frozen-lockfile/g)?.length,
    ).toBe(6);

    const requiredCommands = [
      "corepack pnpm format:check",
      "corepack pnpm lint",
      "corepack pnpm typecheck",
      "corepack pnpm test:unit",
      "corepack pnpm db:check",
      "corepack pnpm db:drift:check",
      "corepack pnpm auth:schema:check",
      "corepack pnpm codegen:check",
      "corepack pnpm test:db",
      "corepack pnpm build",
      "corepack pnpm test:compose:config",
      "corepack pnpm compose:images:verify",
      "corepack pnpm test:compose:lifecycle",
      "corepack pnpm deps:licenses",
      "corepack pnpm deps:audit",
    ];
    for (const command of requiredCommands) {
      expect(workflow, `missing mandatory command: ${command}`).toContain(
        command,
      );
    }
  });

  it("keeps GraphQL-to-MinIO archival in the required Compose lifecycle", () => {
    const workflow = readWorkflow();
    const compose = jobBlock(workflow, "compose-lifecycle");
    const lifecycle = readFileSync("scripts/compose-lifecycle.mjs", "utf8");
    const minioAdapter = readFileSync(
      "tests/integration/minio-upload.test.ts",
      "utf8",
    );

    expect(compose).toContain("corepack pnpm test:compose:lifecycle");
    expect(lifecycle).toContain("runFileLifecycleAcceptance()");
    expect(lifecycle).toContain('"/api/auth/sign-in/email"');
    expect(lifecycle).toContain('"/api/graphql"');
    expect(lifecycle).toContain("createUploadSession");
    expect(lifecycle).toContain("completeUpload");
    expect(lifecycle).toContain("archiveFile");
    expect(lifecycle).toContain("opaque application upload grant");
    expect(lifecycle).toContain("running Compose worker");
    expect(lifecycle).not.toContain("RUN_FILE_LIFECYCLE_MINIO");
    expect(lifecycle).not.toContain("TEST_DATABASE_URL");
    expect(lifecycle).not.toContain("tests/integration/minio-upload.test.ts");
    expect(lifecycle).not.toContain("vitest");
    expect(minioAdapter).not.toContain("ResearchFixture");
    expect(minioAdapter).not.toContain("runJobsOnce");
    expect(minioAdapter).not.toContain("MemoryRedis");
  });

  it("keeps dependency review PR-only and supply-chain artifacts bounded", () => {
    const workflow = readWorkflow();
    const dependency = jobBlock(workflow, "dependency-policy");
    const imageSecurity = jobBlock(workflow, "image-security");

    expect(dependency).toContain("if: github.event_name == 'pull_request'");
    expect(dependency.match(/dependency-review-action@/g)).toHaveLength(1);
    expect(dependency).toContain("fail-on-severity: high");
    expect(dependency).toContain("comment-summary-in-pr: never");

    expect(imageSecurity.match(/docker\/build-push-action@/g)).toHaveLength(1);
    expect(imageSecurity).toContain("load: true");
    expect(imageSecurity).toContain("no-cache: true");
    expect(imageSecurity).toContain("platforms: linux/amd64");
    expect(imageSecurity).toContain("push: false");
    expect(imageSecurity).toContain(
      "node scripts/verify-runtime-image.mjs humans-ci:${{ github.sha }} .tmp/runtime-manifest.json",
    );
    expect(imageSecurity).toContain(
      "node scripts/verify-runtime-image-optimizer.mjs humans-ci:${{ github.sha }}",
    );
    expect(imageSecurity).toContain(
      "node scripts/verify-runtime-sbom.mjs .tmp/runtime-manifest.json sbom.spdx.json",
    );
    expect(
      imageSecurity.match(/humans-ci:\$\{\{ github\.sha \}\}/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(imageSecurity).toContain("dependency-snapshot: false");
    expect(imageSecurity).toContain("upload-artifact: false");
    expect(imageSecurity).toContain("retention-days: 7");
    expect(imageSecurity).toContain("if-no-files-found: error");
    expect(imageSecurity).toContain("severity: HIGH,CRITICAL");
    expect(imageSecurity).toContain("exit-code: 1");
    expect(imageSecurity).not.toMatch(/\.env|\.dump|uploads\/|storage\//u);
  });
});
