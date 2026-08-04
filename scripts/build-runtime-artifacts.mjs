#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nodeFileTrace } from "@vercel/nft";
import { build } from "esbuild";
import {
  assertNoForbiddenRuntimeFiles,
  assertRequiredRuntimePackageIdentities,
  normalizeRuntimePath,
  runtimePackageIdentitiesFromMetadata,
} from "./runtime-boundary.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextRoot = resolve(repositoryRoot, ".next");
const standaloneRoot = resolve(nextRoot, "standalone");
const temporaryRoot = resolve(nextRoot, "runtime-build");
const compiledRoot = resolve(temporaryRoot, "compiled");
const runtimeRoot = resolve(nextRoot, "runtime-root");

const entrypoints = [
  ["src/db/migrate.ts", "migrate.mjs"],
  ["src/db/bootstrap-admin-entry.ts", "bootstrap-admin.mjs"],
  ["src/db/seed.ts", "seed.mjs"],
  ["src/worker/run-continuous.ts", "worker.mjs"],
  ["tests/smoke/worker-active-drain.ts", "worker-active-drain-smoke.mjs"],
  ["tests/smoke/task12-smoke.ts", "task12-smoke.mjs"],
];

const requiredRuntimeFiles = [
  "server.js",
  ".next/static",
  "runtime/migrate.mjs",
  "runtime/bootstrap-admin.mjs",
  "runtime/seed.mjs",
  "runtime/worker.mjs",
  "runtime/worker-active-drain-smoke.mjs",
  "runtime/task12-smoke.mjs",
  "docker/worker-healthcheck.mjs",
  "drizzle",
];

const requiredRuntimePackages = ["next", "postgres"];

export function normalizeTracePath(candidate) {
  try {
    return normalizeRuntimePath(candidate);
  } catch (error) {
    throw new Error(`Unsafe Node File Trace path: ${candidate}`, {
      cause: error,
    });
  }
}

const reviewedTraceWarningMessage =
  "Failed to resolve dependency \"@opentelemetry/api\":\nCannot find module '@opentelemetry/api' loaded from <repository-root>/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_better-call_b5812785fc15f4bc539c8dafa0413617/node_modules/@better-auth/core/dist/instrumentation/api.mjs";
const reviewedAwsTraceWarningMessage =
  "Failed to resolve dependency os from <repository-root>/node_modules/.pnpm/@aws-sdk+credential-provider-ini/index.js because of a dynamic homedir lookup";
const reviewedTraceWarningFingerprints = new Set([
  createHash("sha256").update(reviewedTraceWarningMessage).digest("hex"),
  createHash("sha256").update(reviewedAwsTraceWarningMessage).digest("hex"),
]);

export function reviewedTraceWarning() {
  return reviewedTraceWarningMessage.replace(
    "<repository-root>",
    repositoryRoot,
  );
}

export function reviewedAwsTraceWarning() {
  return reviewedAwsTraceWarningMessage.replace(
    "<repository-root>",
    repositoryRoot,
  );
}

export function validateTraceWarnings(warnings) {
  const unreviewed = [...warnings]
    .map((warning) => String(warning?.message ?? warning))
    .map((message) =>
      message
        .replaceAll(repositoryRoot, "<repository-root>")
        .replaceAll("\\", "/"),
    )
    .filter(
      (message) =>
        !reviewedTraceWarningFingerprints.has(
          createHash("sha256").update(message).digest("hex"),
        ),
    );
  if (unreviewed.length > 0) {
    throw new Error(
      `Unreviewed Node File Trace warning(s):\n${unreviewed.join("\n---\n")}`,
    );
  }
}

export function assertRuntimeFileInventory(files) {
  const normalized = files.map(normalizeTracePath);
  assertNoForbiddenRuntimeFiles(normalized);
  for (const required of requiredRuntimeFiles) {
    if (
      !normalized.some(
        (path) => path === required || path.startsWith(`${required}/`),
      )
    ) {
      throw new Error(`Missing required runtime artifact: ${required}`);
    }
  }
  for (const packageName of requiredRuntimePackages) {
    if (
      !normalized.some(
        (path) =>
          path === `node_modules/${packageName}` ||
          path === `node_modules/${packageName}/package.json` ||
          (path.startsWith("node_modules/.pnpm/") &&
            path.endsWith(`/node_modules/${packageName}/package.json`)),
      )
    ) {
      throw new Error(
        `Missing required runtime package metadata: ${packageName}`,
      );
    }
  }
}

export function assertMinimalRuntimePackage(packageJson) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "scripts",
    "packageManager",
  ]) {
    if (Object.hasOwn(packageJson, section)) {
      throw new Error(`Runtime package.json contains forbidden ${section}`);
    }
  }
}

function assertInside(root, candidate, label) {
  const path = relative(root, candidate);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== "..")) return;
  throw new Error(`${label} escapes its bounded root: ${candidate}`);
}

async function copyEntry(source, destination) {
  const metadata = await lstat(source);
  await mkdir(dirname(destination), { recursive: true });
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyEntry(resolve(source, entry), resolve(destination, entry));
    }
    return;
  }
  if (metadata.isSymbolicLink()) {
    const target = await readlink(source);
    if (isAbsolute(target)) {
      throw new Error(`Absolute runtime symlink is forbidden: ${source}`);
    }
    await rm(destination, { force: true, recursive: true });
    await symlink(target, destination);
    return;
  }
  await rm(destination, { force: true, recursive: true });
  await cp(source, destination, {
    dereference: false,
    force: true,
    preserveTimestamps: false,
    recursive: false,
  });
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else files.push(path);
  }
  return files.sort();
}

export function sharpRuntimePackageNames(
  platform = process.platform,
  architecture = process.arch,
) {
  const supported = new Set([
    "darwin:arm64",
    "darwin:x64",
    "linux:arm64",
    "linux:x64",
  ]);
  const target = `${platform}:${architecture}`;
  if (!supported.has(target)) {
    throw new Error(`Unsupported Sharp runtime platform: ${target}`);
  }
  const suffix = `${platform}-${architecture}`;
  return [`@img/sharp-${suffix}`, `@img/sharp-libvips-${suffix}`];
}

async function copySharpNativeRuntimePackages() {
  const sharpRoot = await realpath(
    resolve(repositoryRoot, "node_modules/.pnpm/node_modules/sharp"),
  );
  assertInside(repositoryRoot, sharpRoot, "Sharp package root");
  const packageNodeModules = dirname(sharpRoot);
  for (const packageName of sharpRuntimePackageNames()) {
    const link = resolve(packageNodeModules, packageName);
    const target = await realpath(link);
    assertInside(repositoryRoot, target, `Sharp native package ${packageName}`);

    const linkPath = normalizeTracePath(relative(repositoryRoot, link));
    const targetPath = normalizeTracePath(relative(repositoryRoot, target));
    await copyEntry(link, resolve(runtimeRoot, linkPath));
    await copyEntry(target, resolve(runtimeRoot, targetPath));
  }
}

async function removeNonRuntimeSources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) await removeNonRuntimeSources(absolute);
    else if (
      entry.isFile() &&
      (entry.name.endsWith(".map") ||
        entry.name.endsWith(".cts") ||
        entry.name.endsWith(".mts") ||
        entry.name.endsWith(".ts") ||
        entry.name.endsWith(".tsx"))
    ) {
      await rm(absolute);
    }
  }
}

async function assertSharpNativeRuntime(root) {
  const files = await listFiles(root);
  const sharedLibrary =
    process.platform === "darwin"
      ? /libvips-[^/]+\/lib\/libvips-cpp\.[^/]+\.dylib$/u
      : /libvips-[^/]+\/lib\/libvips-cpp\.so(?:\.|$)/u;
  for (const required of [/sharp-[^/]+\.node$/u, sharedLibrary]) {
    if (!files.some((path) => required.test(path))) {
      throw new Error(`Missing Sharp native runtime payload: ${required}`);
    }
  }
}

async function assertSymlinksBounded(root, files) {
  const canonicalRoot = await realpath(root);
  for (const path of files) {
    const absolute = resolve(root, path);
    const metadata = await lstat(absolute);
    if (!metadata.isSymbolicLink()) continue;
    const canonicalTarget = await realpath(absolute);
    assertInside(canonicalRoot, canonicalTarget, `Runtime symlink ${path}`);
  }
}

async function collectRuntimePackages(root, files) {
  const entries = await Promise.all(
    files
      .filter(
        (path) =>
          path.includes("node_modules/") && path.endsWith("/package.json"),
      )
      .map(async (path) => ({
        content: await readFile(resolve(root, path), "utf8"),
        path,
      })),
  );
  return runtimePackageIdentitiesFromMetadata(entries);
}

async function createManifest(root, files, runtimePackages) {
  const entries = [];
  for (const path of files) {
    const absolute = resolve(root, path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      entries.push({ path, symlink: await readlink(absolute) });
    } else {
      entries.push({
        path,
        sha256: createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      });
    }
  }
  const normalized = `${JSON.stringify({ entries, runtimePackages })}\n`;
  return {
    entries,
    manifestSha256: createHash("sha256").update(normalized).digest("hex"),
    runtimePackages,
  };
}

async function compileEntrypoints() {
  await mkdir(compiledRoot, { recursive: true });
  for (const [source, output] of entrypoints) {
    await build({
      absWorkingDir: repositoryRoot,
      bundle: true,
      conditions: ["react-server", "node", "import"],
      define: {
        __HUMANS_RUNTIME_ENTRY__: JSON.stringify(output),
      },
      entryPoints: [source],
      format: "esm",
      logLevel: "warning",
      minify: false,
      outfile: resolve(compiledRoot, output),
      packages: "external",
      platform: "node",
      sourcemap: false,
      target: "node24",
      tsconfig: resolve(repositoryRoot, "tsconfig.json"),
    });
  }
}

async function traceExternalRuntimeFiles() {
  const compiledEntrypoints = entrypoints.map(([, output]) =>
    resolve(compiledRoot, output),
  );
  const trace = await nodeFileTrace(compiledEntrypoints, {
    analysis: { emitGlobs: false },
    base: repositoryRoot,
    conditions: ["react-server", "node", "import"],
    exportsOnly: false,
    mixedModules: true,
    processCwd: repositoryRoot,
  });
  validateTraceWarnings(trace.warnings);
  return [...new Set([...trace.fileList, ...trace.esmFileList])]
    .map(normalizeTracePath)
    .filter(
      (path) =>
        path !== "package.json" && !path.startsWith(".next/runtime-build/"),
    )
    .sort();
}

async function assertRequiredPaths(root) {
  for (const path of requiredRuntimeFiles) {
    try {
      await lstat(resolve(root, path));
    } catch {
      throw new Error(`Missing required runtime artifact: ${path}`);
    }
  }
}

export async function buildRuntimeArtifacts() {
  await rm(temporaryRoot, { force: true, recursive: true });
  await rm(runtimeRoot, { force: true, recursive: true });
  await mkdir(compiledRoot, { recursive: true });
  await lstat(resolve(standaloneRoot, "server.js"));

  await compileEntrypoints();
  const tracedFiles = await traceExternalRuntimeFiles();

  await copyEntry(standaloneRoot, runtimeRoot);
  await copyEntry(
    resolve(nextRoot, "static"),
    resolve(runtimeRoot, ".next/static"),
  );
  try {
    await lstat(resolve(repositoryRoot, "public"));
    await copyEntry(
      resolve(repositoryRoot, "public"),
      resolve(runtimeRoot, "public"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await copyEntry(
    resolve(repositoryRoot, "drizzle"),
    resolve(runtimeRoot, "drizzle"),
  );
  await copyEntry(
    resolve(repositoryRoot, "docker/worker-healthcheck.mjs"),
    resolve(runtimeRoot, "docker/worker-healthcheck.mjs"),
  );
  for (const [, output] of entrypoints) {
    await copyEntry(
      resolve(compiledRoot, output),
      resolve(runtimeRoot, "runtime", output),
    );
  }
  for (const path of tracedFiles) {
    const source = resolve(repositoryRoot, path);
    assertInside(repositoryRoot, source, `Trace path ${path}`);
    await copyEntry(source, resolve(runtimeRoot, path));
  }
  await copySharpNativeRuntimePackages();

  const sourcePackage = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const runtimePackage = {
    license: sourcePackage.license,
    name: sourcePackage.name,
    private: true,
    version: sourcePackage.version,
  };
  assertMinimalRuntimePackage(runtimePackage);
  await writeFile(
    resolve(runtimeRoot, "package.json"),
    `${JSON.stringify(runtimePackage, undefined, 2)}\n`,
    { mode: 0o444 },
  );

  await removeNonRuntimeSources(runtimeRoot);

  await assertRequiredPaths(runtimeRoot);
  await assertSharpNativeRuntime(runtimeRoot);
  let files = await listFiles(runtimeRoot);
  assertRuntimeFileInventory(files);
  await assertSymlinksBounded(runtimeRoot, files);
  const runtimePackages = await collectRuntimePackages(runtimeRoot, files);
  assertRequiredRuntimePackageIdentities(
    runtimePackages,
    process.platform,
    process.arch,
  );
  const manifest = await createManifest(runtimeRoot, files, runtimePackages);
  await writeFile(
    resolve(runtimeRoot, "runtime-manifest.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    { mode: 0o444 },
  );
  files = await listFiles(runtimeRoot);
  await writeFile(
    resolve(nextRoot, "runtime-manifest.sha256"),
    `${manifest.manifestSha256}  runtime-manifest.json\n`,
    { mode: 0o644 },
  );
  await rm(temporaryRoot, { force: true, recursive: true });
  process.stdout.write(
    `Built ${files.length} runtime files (${manifest.manifestSha256})\n`,
  );
  return manifest;
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await buildRuntimeArtifacts();
}
