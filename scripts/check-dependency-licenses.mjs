#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const policyPath = resolve("config/allowed-dependency-licenses.json");

/**
 * @typedef {{
 *   schemaVersion: number;
 *   owner: string;
 *   reviewedAt: string;
 *   allowedLicenses: Record<string, string>;
 *   allowedExceptions: Record<string, string>;
 *   exceptions: Array<{
 *     package: string;
 *     version: string;
 *     licenseExpression: string;
 *     owner: string;
 *     reason: string;
 *     expiresOn: string;
 *   }>;
 * }} LicensePolicy
 */

function invalidExpression(expression) {
  return new Error(`Invalid SPDX expression: ${JSON.stringify(expression)}`);
}

function tokenize(expression) {
  const tokens = [];
  let offset = 0;

  while (offset < expression.length) {
    const whitespace = expression.slice(offset).match(/^\s+/u);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    const character = expression[offset];
    if (character === "(" || character === ")") {
      tokens.push(character);
      offset += 1;
      continue;
    }
    const token = expression
      .slice(offset)
      .match(/^[A-Za-z0-9][A-Za-z0-9.+-]*/u)?.[0];
    if (!token) throw invalidExpression(expression);
    tokens.push(token);
    offset += token.length;
  }

  if (tokens.length === 0) throw invalidExpression(expression);
  return tokens;
}

/**
 * Evaluate an SPDX expression against a reviewed allowlist. OR represents a
 * license choice, AND requires every term, and WITH requires explicit approval
 * of the SPDX exception in addition to the base license.
 *
 * @param {string} expression
 * @param {LicensePolicy} policy
 */
export function evaluateLicenseExpression(expression, policy) {
  const tokens = tokenize(expression);
  let position = 0;

  const parsePrimary = () => {
    const token = tokens[position];
    if (token === "(") {
      position += 1;
      const value = parseOr();
      if (tokens[position] !== ")") throw invalidExpression(expression);
      position += 1;
      return value;
    }
    if (
      !token ||
      token === ")" ||
      token === "AND" ||
      token === "OR" ||
      token === "WITH"
    ) {
      throw invalidExpression(expression);
    }
    position += 1;
    const licenseAllowed = Object.hasOwn(policy.allowedLicenses, token);
    if (tokens[position] !== "WITH") return licenseAllowed;

    position += 1;
    const exception = tokens[position];
    if (!exception || ["(", ")", "AND", "OR", "WITH"].includes(exception)) {
      throw invalidExpression(expression);
    }
    position += 1;
    return licenseAllowed && Object.hasOwn(policy.allowedExceptions, exception);
  };

  const parseAnd = () => {
    let value = parsePrimary();
    while (tokens[position] === "AND") {
      position += 1;
      value = parsePrimary() && value;
    }
    return value;
  };

  const parseOr = () => {
    let value = parseAnd();
    while (tokens[position] === "OR") {
      position += 1;
      value = parseAnd() || value;
    }
    return value;
  };

  const allowed = parseOr();
  if (position !== tokens.length) throw invalidExpression(expression);
  return allowed;
}

function readPolicy() {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (
    policy.schemaVersion !== 1 ||
    typeof policy.owner !== "string" ||
    typeof policy.reviewedAt !== "string" ||
    !policy.allowedLicenses ||
    !policy.allowedExceptions ||
    !Array.isArray(policy.exceptions)
  ) {
    throw new Error("Dependency license policy has an invalid schema");
  }
  for (const exception of policy.exceptions) {
    if (
      !exception.package ||
      !exception.version ||
      !exception.licenseExpression ||
      !exception.owner ||
      !exception.reason ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(exception.expiresOn)
    ) {
      throw new Error(
        "Every dependency license exception must be narrow, owned, justified, and expiring",
      );
    }
    if (Date.parse(`${exception.expiresOn}T23:59:59Z`) < Date.now()) {
      throw new Error(
        `Expired dependency license exception: ${exception.package}@${exception.version}`,
      );
    }
  }
  return policy;
}

function licensedPackageVersions(licenses) {
  const records = [];
  for (const [expression, packages] of Object.entries(licenses)) {
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new Error(`License inventory entry has no packages: ${expression}`);
    }
    for (const dependency of packages) {
      if (
        typeof dependency.name !== "string" ||
        !Array.isArray(dependency.versions) ||
        dependency.versions.length === 0
      ) {
        throw new Error(`Malformed license inventory entry: ${expression}`);
      }
      for (const version of dependency.versions) {
        if (typeof version !== "string" || version.length === 0) {
          throw new Error(
            `Malformed dependency version for ${dependency.name}`,
          );
        }
        records.push({ expression, name: dependency.name, version });
      }
    }
  }
  return records;
}

function exceptionAllows(record, policy) {
  return policy.exceptions.some(
    (exception) =>
      exception.package === record.name &&
      exception.version === record.version &&
      exception.licenseExpression === record.expression,
  );
}

function packageLicense(packageJson) {
  const value = packageJson.license ?? packageJson.licenses;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return typeof value.type === "string" ? value.type : "UNKNOWN";
  }
  if (Array.isArray(value)) {
    const expressions = value
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry && typeof entry.type === "string"
            ? entry.type
            : null,
      )
      .filter((entry) => entry !== null);
    return expressions.length > 0 ? expressions.join(" OR ") : "UNKNOWN";
  }
  return "UNKNOWN";
}

function readResolvedPackage(entry) {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      try {
        const packageJson = JSON.parse(readFileSync(candidate, "utf8"));
        if (typeof packageJson.name === "string" && packageJson.version) {
          return { directory, packageJson };
        }
      } catch {
        // Keep walking: packages such as qrcode.react have nested metadata.
      }
    }
    directory = dirname(directory);
  }
  return null;
}

/**
 * pnpm's license command requires a local SQLite package-index cache that is
 * not guaranteed to exist in a fresh checkout. Walk the installed production
 * dependency closure instead so the policy remains deterministic and fails
 * closed for packages without license metadata.
 */
function installedProductionLicenseInventory() {
  const root = process.cwd();
  const rootPackage = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const queue = Object.keys({
    ...rootPackage.dependencies,
    ...rootPackage.optionalDependencies,
  }).map((name) => ({ name, from: root }));
  const seen = new Map();

  while (queue.length > 0) {
    const current = queue.pop();
    const requester = createRequire(join(current.from, "package.json"));
    let entry;
    try {
      entry = requester.resolve(current.name);
    } catch {
      // An optional dependency may not be installed on this platform.
      continue;
    }
    const resolved = readResolvedPackage(entry);
    if (!resolved) continue;
    const { directory, packageJson } = resolved;
    const identity = `${packageJson.name}@${packageJson.version}`;
    if (seen.has(identity)) continue;
    seen.set(identity, {
      expression: packageLicense(packageJson),
      name: packageJson.name,
      version: packageJson.version,
    });
    for (const dependency of Object.keys({
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
    })) {
      queue.push({ name: dependency, from: directory });
    }
  }
  return [...seen.values()];
}

export function runLicenseCheck() {
  const policy = readPolicy();
  const result = spawnSync(
    "corepack",
    ["pnpm", "licenses", "list", "--prod", "--json"],
    { cwd: process.cwd(), encoding: "utf8", shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const diagnostic = `${result.stdout}\n${result.stderr}`;
    if (
      !/ERR_PNPM_MISSING_PACKAGE_INDEX_FILE|ERR_SQLITE_ERROR/u.test(diagnostic)
    ) {
      throw new Error(`pnpm license inventory failed:\n${diagnostic.trim()}`);
    }
    process.stderr.write(
      "pnpm license inventory unavailable; using installed production dependency closure.\n",
    );
    const records = installedProductionLicenseInventory();
    if (records.length === 0)
      throw new Error("Production dependency license inventory is empty");
    return checkRecords(records, policy);
  }

  const records = licensedPackageVersions(JSON.parse(result.stdout));
  return checkRecords(records, policy);
}

function checkRecords(records, policy) {
  if (records.length === 0)
    throw new Error("Production dependency license inventory is empty");

  const failures = records.filter((record) => {
    try {
      return (
        !evaluateLicenseExpression(record.expression, policy) &&
        !exceptionAllows(record, policy)
      );
    } catch {
      return !exceptionAllows(record, policy);
    }
  });
  if (failures.length > 0) {
    const details = failures
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
        ),
      )
      .map(
        (record) => `- ${record.name}@${record.version}: ${record.expression}`,
      )
      .join("\n");
    throw new Error(
      `Unknown or disallowed production dependency licenses:\n${details}`,
    );
  }

  const unique = new Set(
    records.map((record) => `${record.name}@${record.version}`),
  );
  process.stdout.write(
    `Dependency license policy approved ${unique.size} production package versions.\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    runLicenseCheck();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
