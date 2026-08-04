#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const [image] = process.argv.slice(2);
if (!image) {
  process.stderr.write("Usage: verify-runtime-image-optimizer.mjs IMAGE\n");
  process.exit(2);
}

function run(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
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

const requestSource = String.raw`
  const [path, headersJson] = process.argv.slice(1);
  const response = await fetch(new URL(path, "http://127.0.0.1:3000"), {
    headers: JSON.parse(headersJson),
    signal: AbortSignal.timeout(10_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  process.stdout.write(JSON.stringify({
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: body.toString("base64"),
  }));
`;

function fetchInContainer(path, headers = {}) {
  return JSON.parse(
    run([
      "exec",
      containerName,
      "/nodejs/bin/node",
      "-e",
      requestSource,
      path,
      JSON.stringify(headers),
    ]),
  );
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createProbePng() {
  const width = 64;
  const height = 64;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      rows[pixel] = (x * 37 + y * 17) % 256;
      rows[pixel + 1] = (x * 11 + y * 43) % 256;
      rows[pixel + 2] = (x * 29 + y * 7) % 256;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const probeDirectory = await mkdtemp(join(tmpdir(), "humans-image-probe-"));
await chmod(probeDirectory, 0o755);
const containerName = `humans-image-probe-${randomUUID()}`;
let started = false;
try {
  const [inspection] = JSON.parse(run(["image", "inspect", image]));
  if (!["amd64", "arm64"].includes(inspection.Architecture)) {
    throw new Error(
      `Unsupported image architecture: ${inspection.Architecture}`,
    );
  }
  const runtimePlatform = `linux/${inspection.Architecture}`;
  await writeFile(join(probeDirectory, "valid.png"), createProbePng());
  await writeFile(join(probeDirectory, "malformed.png"), "not-an-image\n");
  await writeFile(
    join(probeDirectory, "high-channel.pam"),
    Buffer.concat([
      Buffer.from(
        "P7\nWIDTH 1\nHEIGHT 1\nDEPTH 5\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n",
      ),
      Buffer.from([1, 2, 3, 4, 5]),
    ]),
  );
  run([
    "run",
    "--platform",
    runtimePlatform,
    "--detach",
    "--init",
    "--name",
    containerName,
    "--read-only",
    "--tmpfs",
    "/tmp:mode=1777,size=32m",
    "--tmpfs",
    "/app/.next/cache:uid=65532,gid=65532,mode=0700,size=64m",
    "--volume",
    `${probeDirectory}:/app/public/runtime-probes:ro`,
    image,
    "server.js",
  ]);
  started = true;
  const readinessDeadline = Date.now() + 45_000;
  let lastReadinessError;
  while (true) {
    try {
      const response = fetchInContainer("/api/health/live");
      if (response.ok) break;
      lastReadinessError = new Error(`liveness returned ${response.status}`);
    } catch (error) {
      lastReadinessError = error;
      // The bounded retry below owns startup timing.
    }
    if (Date.now() >= readinessDeadline) {
      const detail =
        lastReadinessError instanceof Error
          ? `: ${lastReadinessError.message}`
          : "";
      throw new Error(
        `Runtime image did not become live for optimizer proof${detail}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const optimize = (name) =>
    fetchInContainer(
      `/_next/image?url=${encodeURIComponent(`/runtime-probes/${name}`)}&w=64&q=75`,
      { accept: "image/webp" },
    );
  const valid = optimize("valid.png");
  const validBody = Buffer.from(valid.body, "base64");
  if (
    !valid.ok ||
    valid.contentType !== "image/webp" ||
    validBody.subarray(0, 4).toString("ascii") !== "RIFF" ||
    validBody.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new Error(
      `Distroless cache-miss optimizer did not produce valid WebP (status=${valid.status}, type=${valid.contentType}, bytes=${validBody.length}, prefix=${validBody.subarray(0, 16).toString("hex")})`,
    );
  }
  for (const name of ["malformed.png", "high-channel.pam"]) {
    const response = optimize(name);
    const body = Buffer.from(response.body, "base64");
    if (
      response.status < 400 ||
      response.status >= 500 ||
      body.length > 16_384
    ) {
      throw new Error(`${name} was not rejected safely and boundedly`);
    }
  }
  if (!fetchInContainer("/api/health/live").ok) {
    throw new Error("Image optimizer rejection destabilized the runtime");
  }

  const versionsSource = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    function findSharp(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "sharp" && fs.existsSync(path.join(absolute, "package.json"))) return absolute;
          const found = findSharp(absolute);
          if (found) return found;
        }
      }
    }
    const root = findSharp("/app/node_modules/.pnpm");
    if (!root) throw new Error("sharp package not found");
    const sharp = require(root);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    process.stdout.write(JSON.stringify({ sharp: pkg.version, vips: sharp.versions.vips }));
  `;
  const versions = JSON.parse(
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
      versionsSource,
    ]),
  );
  if (!versions.sharp || !versions.vips) {
    throw new Error("Sharp/libvips version evidence is incomplete");
  }
  process.stdout.write(
    `Runtime image optimizer passed (Sharp ${versions.sharp}, libvips ${versions.vips})\n`,
  );
} catch (error) {
  if (started) {
    process.stderr.write(
      `Container state: ${run(["inspect", "--format", "{{json .State}}", containerName])}\n`,
    );
    process.stderr.write(`${run(["logs", containerName])}\n`);
  }
  throw error;
} finally {
  if (started) run(["rm", "--force", containerName]);
  await rm(probeDirectory, { force: true, recursive: true });
}
