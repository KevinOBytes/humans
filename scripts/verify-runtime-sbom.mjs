#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { assertRuntimePackagesCoveredBySbom } from "./runtime-boundary.mjs";

const [manifestPath, sbomPath] = process.argv.slice(2);
if (!manifestPath || !sbomPath) {
  process.stderr.write(
    "Usage: verify-runtime-sbom.mjs RUNTIME_MANIFEST SPDX_SBOM\n",
  );
  process.exit(2);
}

const [manifest, sbom] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(sbomPath, "utf8").then(JSON.parse),
]);
if (!Array.isArray(manifest.runtimePackages) || !Array.isArray(sbom.packages)) {
  throw new Error("Runtime manifest or SPDX SBOM has an invalid shape");
}
const sbomPackages = sbom.packages
  .filter(
    (entry) =>
      typeof entry.name === "string" && typeof entry.versionInfo === "string",
  )
  .map((entry) => ({ name: entry.name, version: entry.versionInfo }));
assertRuntimePackagesCoveredBySbom(manifest.runtimePackages, sbomPackages);
const discovered = new Set(
  sbomPackages.map((entry) => `${entry.name}@${entry.version}`),
);
for (const forbidden of [
  "esbuild",
  "@vercel/nft",
  "typescript",
  "vitest",
  "tsx",
  "drizzle-kit",
  "@playwright/test",
]) {
  if ([...discovered].some((entry) => entry.startsWith(`${forbidden}@`))) {
    throw new Error(`SBOM contains forbidden build dependency: ${forbidden}`);
  }
}
process.stdout.write(
  `Verified ${manifest.runtimePackages.length} runtime dependencies in SPDX SBOM\n`,
);
