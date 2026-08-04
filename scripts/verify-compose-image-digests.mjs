#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const APPLICATION_IMAGE_EXPRESSION = "${HUMANS_IMAGE:-humans:local}";
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
]);
const PINNED_IMAGE =
  /^(?<tag>[^@\s]+:[^@\s]+)@sha256:(?<digest>[a-f0-9]{64})$/u;
const composeFiles = process.argv.slice(2);
const files =
  composeFiles.length > 0
    ? composeFiles
    : ["docker-compose.yml", "docker-compose.ollama.yml"];

class VerificationError extends Error {}

function fail(message) {
  throw new VerificationError(message);
}

function directImageReferences(source) {
  const references = [];
  for (const line of source.split("\n")) {
    const match = line.match(
      /^\s*image:\s*(?:"([^"]+)"|'([^']+)'|([^#\s][^#]*?))\s*(?:#.*)?$/u,
    );
    if (!match) continue;

    const reference = (match[1] ?? match[2] ?? match[3]).trim();
    if (reference !== APPLICATION_IMAGE_EXPRESSION) references.push(reference);
  }
  return references;
}

function readReferences() {
  const references = new Set();
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      fail("Compose image configuration is unavailable");
    }
    for (const reference of directImageReferences(source))
      references.add(reference);
  }
  return references;
}

function inspect(tag) {
  const result = spawnSync(
    process.env.DOCKER_BIN || "docker",
    ["buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.error || result.status !== 0) {
    fail("Compose image inspection failed");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("Compose image inspection failed");
  }
}

function verifyReference(reference) {
  const pin = reference.match(PINNED_IMAGE);
  if (!pin?.groups) fail("Compose image reference is not pinned");

  const manifest = inspect(pin.groups.tag);
  if (manifest?.digest !== `sha256:${pin.groups.digest}`) {
    fail("Compose image digest does not match registry");
  }
  if (!INDEX_MEDIA_TYPES.has(manifest?.mediaType)) {
    fail("Compose image is not a multi-platform index");
  }
  const platforms = new Set(
    Array.isArray(manifest?.manifests)
      ? manifest.manifests.map(
          (descriptor) =>
            `${descriptor?.platform?.os}/${descriptor?.platform?.architecture}`,
        )
      : [],
  );
  if (!platforms.has("linux/amd64") || !platforms.has("linux/arm64")) {
    fail("Compose image index lacks linux/amd64 and linux/arm64");
  }
}

try {
  const references = readReferences();
  for (const reference of references) verifyReference(reference);
  process.stdout.write(
    `Verified ${references.size} pinned Compose image indexes\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof VerificationError ? error.message : "Compose image verification failed"}\n`,
  );
  process.exitCode = 1;
}
