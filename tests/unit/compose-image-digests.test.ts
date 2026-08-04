// @vitest-environment node

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const verifier = resolve("scripts/verify-compose-image-digests.mjs");
const matchingDigest = "a".repeat(64);
const otherDigest = "b".repeat(64);

function multiPlatformIndex(digest = matchingDigest) {
  return JSON.stringify({
    digest: `sha256:${digest}`,
    manifests: [
      { platform: { architecture: "amd64", os: "linux" } },
      { platform: { architecture: "arm64", os: "linux" } },
    ],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  });
}

function runVerifier(
  files: Record<string, string>,
  options: {
    manifest?: string;
    suppliedEnvironment?: Record<string, string | undefined>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "humans-compose-digests-"));
  const binaryDirectory = join(directory, "bin");
  const commandLog = join(directory, "docker.log");
  const docker = join(binaryDirectory, "docker");

  mkdirSync(binaryDirectory);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(directory, name), content);
  }
  writeFileSync(commandLog, "");
  writeFileSync(
    docker,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
      'printf "%s" "$FAKE_DOCKER_MANIFEST"',
    ].join("\n"),
  );
  chmodSync(docker, 0o755);

  const result = spawnSync(
    process.execPath,
    [verifier, ...Object.keys(files)],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        ...options.suppliedEnvironment,
        DOCKER_BIN: docker,
        FAKE_DOCKER_LOG: commandLog,
        FAKE_DOCKER_MANIFEST: options.manifest ?? multiPlatformIndex(),
        PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  const commands = readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);

  rmSync(directory, { force: true, recursive: true });
  return { commands, result };
}

function compose(image: string) {
  return `services:\n  service:\n    image: ${image}\n`;
}

describe("Compose third-party image digest verifier", () => {
  it("rejects a tag-only third-party image", () => {
    const { result } = runVerifier({ "compose.yml": compose("redis:8.6.1") });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("Compose image reference is not pinned\n");
  });

  it("ignores the application image expression", () => {
    const { commands, result } = runVerifier({
      "compose.yml": compose("${HUMANS_IMAGE:-humans:local}"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Verified 0 pinned Compose image indexes\n");
    expect(commands).toEqual([]);
  });

  it("rejects a registry digest that differs from the pin", () => {
    const { result } = runVerifier(
      { "compose.yml": compose(`redis:8.6.1@sha256:${matchingDigest}`) },
      { manifest: multiPlatformIndex(otherDigest) },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(
      "Compose image digest does not match registry\n",
    );
  });

  it("rejects a single-platform child manifest media type", () => {
    const { result } = runVerifier(
      { "compose.yml": compose(`redis:8.6.1@sha256:${matchingDigest}`) },
      {
        manifest: JSON.stringify({
          digest: `sha256:${matchingDigest}`,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          schemaVersion: 2,
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("Compose image is not a multi-platform index\n");
  });

  it("rejects an index missing a required Linux platform", () => {
    const { result } = runVerifier(
      { "compose.yml": compose(`redis:8.6.1@sha256:${matchingDigest}`) },
      {
        manifest: JSON.stringify({
          digest: `sha256:${matchingDigest}`,
          manifests: [{ platform: { architecture: "amd64", os: "linux" } }],
          mediaType:
            "application/vnd.docker.distribution.manifest.list.v2+json",
          schemaVersion: 2,
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe(
      "Compose image index lacks linux/amd64 and linux/arm64\n",
    );
  });

  it("accepts and deduplicates matching indexes across Compose files", () => {
    const image = `redis:8.6.1@sha256:${matchingDigest}`;
    const { commands, result } = runVerifier({
      "compose.yml": compose(image),
      "compose.overlay.yml": compose(image),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Verified 1 pinned Compose image indexes\n");
    expect(commands).toEqual([
      `buildx imagetools inspect redis:8.6.1 --format {{json .Manifest}}`,
    ]);
  });

  it("reports fixed diagnostics without supplied environment values", () => {
    const suppliedImage = "registry.example/private-image:never-print-this";
    const { result } = runVerifier(
      { "compose.yml": compose("${UNSAFE_IMAGE:-default-never-print-this}") },
      { suppliedEnvironment: { UNSAFE_IMAGE: suppliedImage } },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toBe("Compose image reference is not pinned\n");
    expect(output).not.toContain(suppliedImage);
    expect(output).not.toContain("default-never-print-this");
  });
});
