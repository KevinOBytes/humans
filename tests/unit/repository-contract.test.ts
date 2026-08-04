import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

function checkIgnore(path: string, diagnostic = false) {
  return spawnSync(
    "git",
    [
      "check-ignore",
      "--no-index",
      ...(diagnostic ? ["--verbose", "--non-matching"] : []),
      "--",
      path,
    ],
    { cwd: process.cwd(), encoding: "utf8", shell: false },
  );
}

describe("public repository contract", () => {
  it("contains the public project and contributor documentation", () => {
    for (const path of [
      "LICENSE",
      "README.md",
      "AGENTS.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "TODO.md",
      "docs/ARCHITECTURE.md",
      "docs/REQUIREMENTS.md",
      "docs/DESIGN.md",
    ]) {
      expect(existsSync(path), `${path} must exist`).toBe(true);
    }

    expect(read("LICENSE")).toContain("Apache License");
    expect(read("LICENSE")).toContain("Version 2.0");
  });

  it("uses Git's effective rules to ignore secrets, local data, and agent scratch state", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".superpowers/probe",
      ".codex/probe",
      ".claude/probe",
      "data/probe",
      "uploads/probe",
      "output/playwright/probe.log",
    ]) {
      const result = checkIgnore(path, true);

      expect(result.error, `${path}: ${result.stderr}`).toBeUndefined();
      expect(result.status, `${path}: ${result.stderr}`).toBe(0);
      expect(
        result.stdout,
        `${path} must report its effective ignore rule`,
      ).toContain(path);
      expect(
        result.stdout,
        `${path} must identify the effective ignore file`,
      ).toContain(".gitignore");
    }
  });

  it("uses Git's effective rules to keep public repository inputs trackable", () => {
    for (const path of [
      ".env.example",
      "AGENTS.md",
      "src/app/page.tsx",
      ".github/workflows/ci.yml",
    ]) {
      const result = checkIgnore(path);
      const diagnostic = checkIgnore(path, true);

      expect(result.error, `${path}: ${result.stderr}`).toBeUndefined();
      expect(result.status, `${path} must remain trackable`).toBe(1);
      expect(diagnostic.error, `${path}: ${diagnostic.stderr}`).toBeUndefined();
      expect(
        diagnostic.stdout,
        `${path} must produce a useful non-matching diagnostic`,
      ).toContain(path);
    }
  });

  it("keeps browser artifacts out of Docker builds without excluding source", () => {
    const dockerIgnore = read(".dockerignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(dockerIgnore).toEqual(
      expect.arrayContaining([
        "output/playwright",
        "playwright-report",
        "test-results",
      ]),
    );
    for (const sourcePath of ["src", "package.json", "Dockerfile"]) {
      expect(
        dockerIgnore,
        `${sourcePath} must remain in the build context`,
      ).not.toContain(sourcePath);
    }
    expect(read("Dockerfile")).toContain("COPY . .");
  });

  it("documents every public environment variable without real credentials", () => {
    const example = read(".env.example");

    for (const variable of [
      "DEPLOYMENT_MODE",
      "NEXT_PUBLIC_APP_URL",
      "DATABASE_URL",
      "POSTGRES_PASSWORD",
      "REDIS_URL",
      "REDIS_PASSWORD",
      "REDIS_TOKEN",
      "STORAGE_ENDPOINT",
      "STORAGE_REGION",
      "STORAGE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
      "STORAGE_FORCE_PATH_STYLE",
      "STORAGE_BUCKET_PUBLIC",
      "MINIO_ROOT_USER",
      "MINIO_ROOT_PASSWORD",
      "AUTH_SECRET",
      "AUTH_SECURE_COOKIES",
      "AUTH_TRUSTED_ORIGINS",
      "AUTH_ENCRYPTION_KEY",
      "DATA_ENCRYPTION_KEY",
      "ADMIN_EMAIL",
      "ADMIN_USERNAME",
      "ADMIN_DISPLAY_NAME",
      "ADMIN_PASSWORD",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      "AI_PROVIDER",
      "AI_BASE_URL",
      "AI_API_KEY",
      "AI_MODEL",
    ]) {
      expect(example, `${variable} must be documented`).toMatch(
        new RegExp(`^${variable}=`, "m"),
      );
    }

    expect(example).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(example).not.toMatch(/re_[A-Za-z0-9]{20,}/);
  });

  it("loads the ignored source quick-start environment for one-shot Node scripts", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const readme = read("README.md");

    expect(readme).toContain("cp .env.example .env.local");
    for (const script of ["db:migrate", "admin:bootstrap"]) {
      expect(packageJson.scripts[script]).toMatch(
        /^node --env-file-if-exists=\.env\.local /u,
      );
      expect(packageJson.scripts[script]).not.toContain("ADMIN_PASSWORD=");
    }
  });

  it("links every incomplete MVP requirement to exactly one TODO", () => {
    const requirements = read("docs/REQUIREMENTS.md");
    const todo = read("TODO.md");
    const requirementIds = new Set(
      requirements.match(/HUM-(?:FR|NFR)-\d{3}/g) ?? [],
    );
    const incompleteIds = new Set(
      requirements
        .split("\n")
        .filter((line) =>
          /^\| `HUM-(?:FR|NFR)-\d{3}` .+\| Incomplete \|$/.test(line),
        )
        .flatMap((line) => line.match(/HUM-(?:FR|NFR)-\d{3}/g) ?? []),
    );
    const todoLines = todo.split("\n").filter((line) => line.startsWith("- ["));
    const todoIds = todoLines.flatMap(
      (line) => line.match(/HUM-(?:FR|NFR)-\d{3}/g) ?? [],
    );

    expect(requirementIds.size).toBeGreaterThan(0);
    expect(incompleteIds.size).toBeGreaterThan(0);
    expect(todoLines.length).toBeGreaterThan(0);
    for (const line of todoLines) {
      expect(line).toMatch(/^- \[ \] `HUM-(?:FR|NFR)-\d{3}`/);
      const id = line.match(/HUM-(?:FR|NFR)-\d{3}/)?.[0];
      expect(requirementIds, `${id} must exist in requirements`).toContain(id);
    }
    expect(new Set(todoIds)).toEqual(incompleteIds);
    expect(todoIds).toHaveLength(incompleteIds.size);
  });

  it("ships separate environment parser and server accessor modules", () => {
    expect(existsSync("src/lib/env/server-schema.ts")).toBe(true);
    expect(existsSync("src/lib/env/server.ts")).toBe(true);
  });

  it("tracks measurable production performance budgets as incomplete", () => {
    const requirements = read("docs/REQUIREMENTS.md");
    const todo = read("TODO.md");

    expect(requirements).toMatch(/^\| `HUM-NFR-020` .+\| Incomplete \|$/m);
    for (const target of [
      "p95",
      "500 ms",
      "2.5 s",
      "200 ms",
      "0.1",
      "250 KiB",
      "30 FPS",
    ]) {
      expect(requirements).toContain(target);
    }
    expect(todo.match(/`HUM-NFR-020`/g)).toHaveLength(1);
    expect(todo).toMatch(/^- \[ \] `HUM-NFR-020`/m);
  });

  it("keeps public agent guidance free of private paths and secret values", () => {
    const agents = read("AGENTS.md");

    expect(agents).not.toMatch(/\/Users\//);
    expect(agents).not.toMatch(/(?:API_KEY|PASSWORD|SECRET)=\S+/);
  });
});
