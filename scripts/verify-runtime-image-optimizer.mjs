#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Unable to allocate an image-optimizer port");
  return port;
}

async function fetchBounded(url, headers) {
  return fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
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
  const port = await availablePort();
  run([
    "run",
    "--platform",
    runtimePlatform,
    "--detach",
    "--name",
    containerName,
    "--read-only",
    "--tmpfs",
    "/tmp:mode=1777,size=32m",
    "--tmpfs",
    "/app/.next/cache:uid=65532,gid=65532,mode=0700,size=64m",
    "--volume",
    `${probeDirectory}:/app/public/runtime-probes:ro`,
    "--publish",
    `127.0.0.1:${port}:3000`,
    image,
    "server.js",
  ]);
  started = true;
  const baseUrl = `http://127.0.0.1:${port}`;
  const readinessDeadline = Date.now() + 15_000;
  while (true) {
    try {
      const response = await fetchBounded(`${baseUrl}/api/health/live`);
      if (response.ok) break;
    } catch {
      // The bounded retry below owns startup timing.
    }
    if (Date.now() >= readinessDeadline) {
      throw new Error("Runtime image did not become live for optimizer proof");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const optimize = (name) =>
    fetchBounded(
      `${baseUrl}/_next/image?url=${encodeURIComponent(`/runtime-probes/${name}`)}&w=64&q=75`,
      { accept: "image/webp" },
    );
  const valid = await optimize("valid.png");
  const validBody = Buffer.from(await valid.arrayBuffer());
  if (
    !valid.ok ||
    valid.headers.get("content-type") !== "image/webp" ||
    validBody.subarray(0, 4).toString("ascii") !== "RIFF" ||
    validBody.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new Error(
      `Distroless cache-miss optimizer did not produce valid WebP (status=${valid.status}, type=${valid.headers.get("content-type")}, bytes=${validBody.length}, prefix=${validBody.subarray(0, 16).toString("hex")})`,
    );
  }
  for (const name of ["malformed.png", "high-channel.pam"]) {
    const response = await optimize(name);
    const body = Buffer.from(await response.arrayBuffer());
    if (
      response.status < 400 ||
      response.status >= 500 ||
      body.length > 16_384
    ) {
      throw new Error(`${name} was not rejected safely and boundedly`);
    }
  }
  if (!(await fetchBounded(`${baseUrl}/api/health/live`)).ok) {
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
    process.stderr.write(`${run(["logs", containerName])}\n`);
  }
  throw error;
} finally {
  if (started) run(["rm", "--force", containerName]);
  await rm(probeDirectory, { force: true, recursive: true });
}
