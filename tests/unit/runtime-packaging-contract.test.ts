// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertMinimalRuntimePackage,
  assertRuntimeFileInventory,
  normalizeTracePath,
  reviewedAwsTraceWarning,
  reviewedTraceWarning,
  sharpRuntimePackageNames,
  validateTraceWarnings,
} from "../../scripts/build-runtime-artifacts.mjs";
import {
  assertNoForbiddenRuntimeFiles,
  assertRequiredRuntimePackageIdentities,
  assertRuntimePackageInventory,
  assertRuntimePackagesCoveredBySbom,
  runtimePackageIdentitiesFromMetadata,
} from "../../scripts/runtime-boundary.mjs";

describe("runtime artifact packaging contract", () => {
  it.each([
    "/absolute/path",
    "../escape",
    "safe/../../escape",
    "C:\\escape",
    "safe\\..\\escape",
  ])("rejects an escaping trace path: %s", (path) => {
    expect(() => normalizeTracePath(path)).toThrow(/trace path/i);
  });

  it("allows only the exact reviewed absent optional-telemetry warning", () => {
    expect(() =>
      validateTraceWarnings([new Error(reviewedTraceWarning())]),
    ).not.toThrow();
    expect(() =>
      validateTraceWarnings([new Error(reviewedAwsTraceWarning())]),
    ).not.toThrow();
    for (const warning of [
      "Failed to resolve mystery-package",
      `${reviewedTraceWarning()} while parsing credentials`,
      reviewedTraceWarning().replace("api.mjs", "api.js"),
      "Failed to parse @aws-sdk credentials beneath homedir/.aws",
      "Failed to resolve @smithy package from homedir",
    ]) {
      expect(() => validateTraceWarnings([new Error(warning)])).toThrow(
        /unreviewed Node File Trace warning/i,
      );
    }
  });

  it("rejects forbidden runtime files and requires deployable metadata", () => {
    const valid = [
      "server.js",
      ".next/static/chunks/app.js",
      "public/.gitkeep",
      "runtime/migrate.mjs",
      "runtime/bootstrap-admin.mjs",
      "runtime/seed.mjs",
      "runtime/worker.mjs",
      "runtime/worker-active-drain-smoke.mjs",
      "runtime/task12-smoke.mjs",
      "docker/worker-healthcheck.mjs",
      "drizzle/0000_core.sql",
      "node_modules/next/package.json",
      "node_modules/postgres/package.json",
    ];
    expect(() => assertRuntimeFileInventory(valid)).not.toThrow();

    for (const forbidden of [
      "node_modules/.bin/tsx",
      "node_modules/esbuild/bin/esbuild",
      "node_modules/@vercel/nft/package.json",
      "node_modules/typescript/package.json",
      "node_modules/vitest/package.json",
      "node_modules/drizzle-kit/package.json",
      "tests/smoke/task12-smoke.ts",
      "src/db/migrate.ts",
      "node_modules/example/source.cts",
      "node_modules/example/source.mts",
      ".env.production",
      ".superpowers/sdd/progress.md",
      ".codex/agents/private.md",
      ".claude/settings.json",
      ".hermes/session.json",
      ".github/workflows/ci.yml",
      ".tmp/runtime-secret",
      "storage/private-object",
      "uploads/person.jpg",
      "data/database.dump",
      "volumes/postgres/state",
      "server.js.map",
    ]) {
      expect(() => assertRuntimeFileInventory([...valid, forbidden])).toThrow(
        /forbidden runtime artifact/i,
      );
    }
  });

  it("derives complete package identities from the final assembled tree", () => {
    const entries = [
      ["node_modules/next/package.json", "next", "16.2.12"],
      ["node_modules/react-dom/package.json", "react-dom", "19.2.4"],
      ["node_modules/postgres/package.json", "postgres", "3.4.8"],
      ["node_modules/sharp/package.json", "sharp", "0.35.3"],
      [
        "node_modules/@img/sharp-linux-arm64/package.json",
        "@img/sharp-linux-arm64",
        "0.35.3",
      ],
      [
        "node_modules/@img/sharp-libvips-linux-arm64/package.json",
        "@img/sharp-libvips-linux-arm64",
        "1.2.4",
      ],
      [
        "node_modules/next/dist/compiled/@next/env/package.json",
        "@next/env",
        "16.2.12",
      ],
    ].map(([path, name, version]) => ({
      content: JSON.stringify({ name, version }),
      path,
    }));
    const packages = runtimePackageIdentitiesFromMetadata(entries);

    expect(packages).toHaveLength(entries.length);
    expect(packages).toContainEqual({ name: "react-dom", version: "19.2.4" });
    expect(packages).toContainEqual({ name: "sharp", version: "0.35.3" });
    expect(packages).toContainEqual({ name: "@next/env", version: "16.2.12" });
    expect(() =>
      assertRequiredRuntimePackageIdentities(packages, "linux", "arm64"),
    ).not.toThrow();
    expect(() =>
      assertRequiredRuntimePackageIdentities(
        packages.map((entry) => ({
          ...entry,
          name: entry.name.replace("linux-arm64", "linux-x64"),
        })),
        "linux",
        "amd64",
      ),
    ).not.toThrow();
    expect(() =>
      assertRequiredRuntimePackageIdentities(
        [...packages, { name: "@opentelemetry/api", version: "1.9.0" }],
        "linux",
        "arm64",
      ),
    ).toThrow(/unexpected optional OpenTelemetry peer/i);
    expect(() =>
      runtimePackageIdentitiesFromMetadata([
        {
          content: JSON.stringify({ name: "next" }),
          path: "node_modules/next/package.json",
        },
      ]),
    ).toThrow(/missing runtime package identity/i);
  });

  it("rejects omissions from the image manifest and SPDX coverage", () => {
    const complete = [
      { name: "next", version: "16.2.12" },
      { name: "react-dom", version: "19.2.4" },
      { name: "sharp", version: "0.35.3" },
    ];

    expect(() =>
      assertRuntimePackageInventory(complete.slice(0, 1), complete),
    ).toThrow(/react-dom@19\.2\.4.*sharp@0\.35\.3/u);
    expect(() =>
      assertRuntimePackagesCoveredBySbom(complete, complete.slice(0, 2)),
    ).toThrow(/sharp@0\.35\.3/u);
  });

  it("shares one private-material boundary across build and image verification", () => {
    for (const path of [
      ".git/config",
      ".env.local",
      ".superpowers/plan.md",
      ".codex/private.json",
      ".claude/settings.json",
      ".hermes/session.json",
      "tests/fixture.ts",
      "src/private.ts",
      "uploads/private.jpg",
      "data/humans.dump",
      "storage/object",
      "volumes/postgres/file",
    ]) {
      expect(() => assertNoForbiddenRuntimeFiles([path])).toThrow(
        /forbidden runtime artifact/i,
      );
    }

    const imageVerifier = readFileSync(
      "scripts/verify-runtime-image.mjs",
      "utf8",
    );
    expect(imageVerifier).toContain(
      "assertNoForbiddenRuntimeFiles(probe.files)",
    );
    expect(imageVerifier).toContain("assertRuntimePackageInventory");
  });

  it("keeps the root runtime manifest free of dependency and tool metadata", () => {
    expect(() =>
      assertMinimalRuntimePackage({
        license: "Apache-2.0",
        name: "humans",
        private: true,
        version: "0.1.0",
      }),
    ).not.toThrow();
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "scripts",
      "packageManager",
    ]) {
      expect(() => assertMinimalRuntimePackage({ [section]: {} })).toThrow(
        /runtime package\.json contains forbidden/i,
      );
    }
  });

  it("selects only the exact Sharp native packages for the build platform", () => {
    expect(sharpRuntimePackageNames("linux", "arm64")).toEqual([
      "@img/sharp-linux-arm64",
      "@img/sharp-libvips-linux-arm64",
    ]);
    expect(sharpRuntimePackageNames("linux", "x64")).toEqual([
      "@img/sharp-linux-x64",
      "@img/sharp-libvips-linux-x64",
    ]);
    expect(sharpRuntimePackageNames("darwin", "arm64")).toEqual([
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
    ]);
    expect(() => sharpRuntimePackageNames("win32", "x64")).toThrow(
      /unsupported Sharp runtime platform/i,
    );
  });

  it("builds a standalone artifact tree without runtime package managers", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const dockerignore = readFileSync(".dockerignore", "utf8");

    expect(packageJson.scripts["runtime:build"]).toBe(
      "node scripts/build-runtime-artifacts.mjs",
    );
    expect(packageJson.devDependencies.esbuild).toBe("0.28.1");
    expect(packageJson.devDependencies["@vercel/nft"]).toBe("1.10.2");
    expect(packageJson.dependencies["@opentelemetry/api"]).toBeUndefined();
    expect(dockerfile).toContain("pnpm runtime:build");
    expect(dockerfile).toContain("/app/.next/runtime-root/ /app/");
    expect(dockerfile).not.toContain(
      'ENTRYPOINT ["/app/docker/entrypoint.sh"]',
    );
    expect(dockerignore).toContain(".tmp");
    expect(dockerignore).toContain(".next/runtime-root");
  });
});
