import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/ci.yml";

const officialActions = new Map([
  [
    "actions/checkout",
    { sha: "d23441a48e516b6c34aea4fa41551a30e30af803", tag: "v6.1.0" },
  ],
  [
    "actions/setup-node",
    { sha: "249970729cb0ef3589644e2896645e5dc5ba9c38", tag: "v6.5.0" },
  ],
  [
    "pnpm/action-setup",
    { sha: "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", tag: "v4.4.0" },
  ],
  [
    "actions/upload-artifact",
    { sha: "b7c566a772e6b6bfb58ed0dc250532a479d7789f", tag: "v6.0.0" },
  ],
  [
    "actions/dependency-review-action",
    { sha: "2031cfc080254a8a887f58cffee85186f0e49e48", tag: "v4.9.0" },
  ],
  [
    "gitleaks/gitleaks-action",
    { sha: "ff98106e4c7b2bc287b24eaf42907196329070c7", tag: "v2.3.9" },
  ],
  [
    "docker/setup-buildx-action",
    { sha: "8d2750c68a42422c14e847fe6c8ac0403b4cbd6f", tag: "v3.12.0" },
  ],
  [
    "docker/build-push-action",
    { sha: "10e90e3645eae34f1e60eeb005ba3a3d33f178e8", tag: "v6.19.2" },
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
      /^on:\n  push:\n  pull_request:\n  workflow_dispatch:\s*$/m,
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
