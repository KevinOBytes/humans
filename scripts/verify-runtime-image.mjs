#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertNoForbiddenRuntimeFiles,
  assertRequiredRuntimePackageIdentities,
  assertRuntimePackageInventory,
  runtimePackageIdentitiesFromMetadata,
} from "./runtime-boundary.mjs";

const [image, manifestOutput = ".tmp/runtime-manifest.json"] =
  process.argv.slice(2);
if (!image) {
  process.stderr.write(
    "Usage: verify-runtime-image.mjs IMAGE [runtime-manifest-output]\n",
  );
  process.exit(2);
}

function run(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker ${arguments_[0]} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

const [inspection] = JSON.parse(run(["image", "inspect", image]));
const config = inspection.Config ?? {};
const expectedLabels = {
  "org.humans.base-resolution-date": "2026-08-03",
  "org.humans.builder.digest":
    "sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573",
  "org.opencontainers.image.base.digest":
    "sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212",
};
if (config.User !== "65532:65532") throw new Error("Runtime user is not 65532");
if (config.WorkingDir !== "/app")
  throw new Error("Runtime workdir is not /app");
if (JSON.stringify(config.Entrypoint) !== '["/nodejs/bin/node"]') {
  throw new Error("Runtime entrypoint is not direct Distroless Node");
}
if (JSON.stringify(config.Cmd) !== '["server.js"]') {
  throw new Error("Runtime command is not the standalone server");
}
if (!["amd64", "arm64"].includes(inspection.Architecture)) {
  throw new Error(
    `Unsupported runtime architecture: ${inspection.Architecture}`,
  );
}
const runtimePlatform = `linux/${inspection.Architecture}`;
for (const [label, value] of Object.entries(expectedLabels)) {
  if (config.Labels?.[label] !== value) {
    throw new Error(`Runtime image label mismatch: ${label}`);
  }
}

const probeSource = String.raw`
  const fs = require("node:fs");
  const path = require("node:path");
  function walk(directory, root = directory, result = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) walk(absolute, root, result);
      else result.push(relative);
    }
    return result;
  }
  let rootWriteError;
  try { fs.writeFileSync("/runtime-write-probe", "forbidden"); }
  catch (error) { rootWriteError = error.code; }
  const packageJson = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
  const files = walk("/app");
  process.stdout.write(JSON.stringify({
    files,
    gid: process.getgid(),
    node: process.versions.node,
    packageMetadata: files
      .filter((entry) => entry.includes("node_modules/") && entry.endsWith("/package.json"))
      .map((entry) => ({
        content: fs.readFileSync(path.join("/app", entry), "utf8"),
        path: entry,
      })),
    packageJson,
    rootWriteError,
    shellExists: fs.existsSync("/bin/sh") || fs.existsSync("/usr/bin/sh"),
    uid: process.getuid(),
  }));
`;
const probe = JSON.parse(
  run([
    "run",
    "--platform",
    runtimePlatform,
    "--rm",
    "--read-only",
    "--entrypoint",
    "/nodejs/bin/node",
    image,
    "-e",
    probeSource,
  ]),
);
if (!/^24\./u.test(probe.node) || probe.uid !== 65532 || probe.gid !== 65532) {
  throw new Error("Runtime Node version or numeric identity is invalid");
}
if (probe.shellExists) throw new Error("A shell exists in the runtime image");
if (!new Set(["EROFS", "EACCES"]).has(probe.rootWriteError)) {
  throw new Error("Read-only runtime root was writable");
}
run([
  "run",
  "--platform",
  runtimePlatform,
  "--rm",
  "--read-only",
  "--entrypoint",
  "/nodejs/bin/node",
  image,
  "--conditions=react-server",
  "-e",
  "Promise.all(['/app/runtime/migrate.mjs','/app/runtime/bootstrap-admin.mjs','/app/runtime/seed.mjs','/app/runtime/worker.mjs'].map((path)=>import(path)))",
]);
for (const section of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "scripts",
  "packageManager",
]) {
  if (Object.hasOwn(probe.packageJson, section)) {
    throw new Error(`Runtime package.json exposes ${section}`);
  }
}

const requiredFiles = [
  "server.js",
  "runtime/migrate.mjs",
  "runtime/bootstrap-admin.mjs",
  "runtime/seed.mjs",
  "runtime/worker.mjs",
  "runtime/worker-active-drain-smoke.mjs",
  "runtime/task12-smoke.mjs",
  "docker/worker-healthcheck.mjs",
  "runtime-manifest.json",
];
for (const path of requiredFiles) {
  if (!probe.files.includes(path))
    throw new Error(`Missing image file: ${path}`);
}
assertNoForbiddenRuntimeFiles(probe.files);

const containerName = `humans-runtime-manifest-${randomUUID()}`;
let containerCreated = false;
try {
  run([
    "create",
    "--platform",
    runtimePlatform,
    "--name",
    containerName,
    image,
  ]);
  containerCreated = true;
  await mkdir(dirname(resolve(manifestOutput)), { recursive: true });
  run(["cp", `${containerName}:/app/runtime-manifest.json`, manifestOutput]);
} finally {
  if (containerCreated) run(["rm", "--force", containerName]);
}
const manifest = JSON.parse(await readFile(resolve(manifestOutput), "utf8"));
if (
  !Array.isArray(manifest.entries) ||
  !Array.isArray(manifest.runtimePackages)
) {
  throw new Error("Runtime manifest is incomplete");
}
const assembledPackages = runtimePackageIdentitiesFromMetadata(
  probe.packageMetadata,
);
assertRequiredRuntimePackageIdentities(
  assembledPackages,
  "linux",
  inspection.Architecture,
);
assertRuntimePackageInventory(manifest.runtimePackages, assembledPackages);
process.stdout.write(
  `Verified ${image} (${inspection.Architecture}, Node ${probe.node}, ${probe.files.length} files, ${manifest.runtimePackages.length} runtime packages)\n`,
);
