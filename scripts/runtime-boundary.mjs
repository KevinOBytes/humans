import { isAbsolute } from "node:path";

export const forbiddenRuntimePatterns = Object.freeze([
  /(^|\/)\.git(?:\/|$)/u,
  /(^|\/)\.github(?:\/|$)/u,
  /(^|\/)\.env(?:\.|$)/u,
  /(^|\/)\.superpowers(?:\/|$)/u,
  /(^|\/)\.codex(?:\/|$)/u,
  /(^|\/)\.claude(?:\/|$)/u,
  /(^|\/)\.hermes(?:\/|$)/u,
  /(^|\/)\.tmp(?:\/|$)/u,
  /^(?:tests|src|docs|coverage|playwright-report|test-results)(?:\/|$)/u,
  /^(?:uploads|data|storage|volumes)(?:\/|$)/u,
  /^(?:Dockerfile|docker-compose(?:\.[^.]+)?\.ya?ml|\.dockerignore)$/u,
  /^(?:README|TODO|AGENTS)\.md$/u,
  /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|\.npmrc)$/u,
  /^(?:tsconfig|next\.config|drizzle\.config|eslint\.config|postcss\.config|vitest\.config|playwright\.config)(?:\.[^/]+)+$/u,
  /\.(?:cts|mts|ts|tsx)$/u,
  /\.map$/u,
  /(^|\/)node_modules\/(?:\.bin\/)?(?:corepack|npm|pnpm|tsx|typescript|vitest|drizzle-kit|esbuild)(?:\/|$)/u,
  /(^|\/)node_modules\/@vercel\/nft(?:\/|$)/u,
  /(^|\/)node_modules\/@playwright(?:\/|$)/u,
  /(^|\/)node_modules\/\.pnpm\/(?:@vercel\+nft|@playwright|corepack|npm@|pnpm@|tsx@|typescript@|vitest@|drizzle-kit@|esbuild@)/u,
  /\.(?:dump|sql\.gz|bak|backup)$/u,
  /^(?!drizzle\/).+\.sql$/u,
]);

const packageRootPattern =
  /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u;

export function normalizeRuntimePath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Invalid empty runtime path");
  }
  const portable = candidate.replaceAll("\\", "/");
  if (
    isAbsolute(candidate) ||
    /^[A-Za-z]:\//u.test(portable) ||
    portable.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Unsafe runtime path: ${candidate}`);
  }
  const normalized = portable
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized) throw new Error(`Unsafe runtime path: ${candidate}`);
  return normalized;
}

export function assertNoForbiddenRuntimeFiles(files) {
  for (const candidate of files) {
    const path = normalizeRuntimePath(candidate);
    if (forbiddenRuntimePatterns.some((pattern) => pattern.test(path))) {
      throw new Error(`Forbidden runtime artifact: ${path}`);
    }
  }
}

function validIdentityField(value) {
  return typeof value === "string" && value.trim() === value && value !== "";
}

export function runtimePackageIdentitiesFromMetadata(entries) {
  const packages = new Map();
  for (const entry of entries) {
    const path = normalizeRuntimePath(entry?.path);
    if (!path.includes("node_modules/") || !path.endsWith("/package.json")) {
      throw new Error(`Invalid runtime package metadata path: ${path}`);
    }

    let metadata;
    try {
      metadata = JSON.parse(entry.content);
    } catch {
      throw new Error(`Invalid runtime package metadata JSON: ${path}`);
    }
    const hasName = validIdentityField(metadata?.name);
    const hasVersion = validIdentityField(metadata?.version);
    if (packageRootPattern.test(path) && (!hasName || !hasVersion)) {
      throw new Error(`Missing runtime package identity: ${path}`);
    }
    // Nested package.json files used as module metadata are not package roots.
    // Include them when they declare a complete identity, otherwise ignore them.
    if (!hasName || !hasVersion) continue;
    packages.set(`${metadata.name}@${metadata.version}`, {
      name: metadata.name,
      version: metadata.version,
    });
  }
  return [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
}

function packageKeys(packages, label) {
  if (!Array.isArray(packages)) {
    throw new Error(`${label} runtime package inventory is invalid`);
  }
  const keys = packages.map((entry) => {
    if (
      !validIdentityField(entry?.name) ||
      !validIdentityField(entry?.version)
    ) {
      throw new Error(`${label} runtime package identity is invalid`);
    }
    return `${entry.name}@${entry.version}`;
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label} runtime package inventory contains duplicates`);
  }
  return keys.sort();
}

export function assertRuntimePackageInventory(expected, actual) {
  const expectedKeys = packageKeys(expected, "Manifest");
  const actualKeys = packageKeys(actual, "Assembled");
  const missing = actualKeys.filter((key) => !expectedKeys.includes(key));
  const unexpected = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Runtime package inventory mismatch; omitted: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
}

/**
 * @param {Array<{name: string, version: string}>} packages
 * @param {string} [platform]
 * @param {string} [architecture]
 */
export function assertRequiredRuntimePackageIdentities(
  packages,
  platform = process.platform,
  architecture = process.arch,
) {
  const names = new Set(packages.map((entry) => entry.name));
  const packageArchitecture = architecture === "amd64" ? "x64" : architecture;
  if (names.has("@opentelemetry/api")) {
    throw new Error(
      "Unexpected optional OpenTelemetry peer in runtime package inventory",
    );
  }
  for (const required of [
    "next",
    "react-dom",
    "postgres",
    "sharp",
    `@img/sharp-${platform}-${packageArchitecture}`,
    `@img/sharp-libvips-${platform}-${packageArchitecture}`,
  ]) {
    if (!names.has(required)) {
      throw new Error(`Missing required runtime package identity: ${required}`);
    }
  }
}

export function assertRuntimePackagesCoveredBySbom(
  runtimePackages,
  sbomPackages,
) {
  const required = packageKeys(runtimePackages, "Manifest");
  if (!Array.isArray(sbomPackages)) {
    throw new Error("SBOM runtime package inventory is invalid");
  }
  const discovered = new Set(
    sbomPackages.map((entry) => {
      if (
        !validIdentityField(entry?.name) ||
        !validIdentityField(entry?.version)
      ) {
        throw new Error("SBOM runtime package identity is invalid");
      }
      return `${entry.name}@${entry.version}`;
    }),
  );
  for (const key of required) {
    if (!discovered.has(key)) {
      throw new Error(`SBOM omitted runtime dependency: ${key}`);
    }
  }
}
