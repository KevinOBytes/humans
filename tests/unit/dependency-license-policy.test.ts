// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  evaluateLicenseExpression,
  type LicensePolicy,
} from "../../scripts/check-dependency-licenses.mjs";

const policy = JSON.parse(
  readFileSync("config/allowed-dependency-licenses.json", "utf8"),
) as LicensePolicy;

describe("production dependency license policy", () => {
  it("evaluates SPDX AND, OR, WITH, and parentheses without accepting unknown terms", () => {
    expect(evaluateLicenseExpression("MIT", policy)).toBe(true);
    expect(evaluateLicenseExpression("MIT OR GPL-3.0-only", policy)).toBe(true);
    expect(evaluateLicenseExpression("MIT AND Apache-2.0", policy)).toBe(true);
    expect(
      evaluateLicenseExpression("MIT AND (Apache-2.0 OR GPL-3.0-only)", policy),
    ).toBe(true);
    expect(evaluateLicenseExpression("MIT AND GPL-3.0-only", policy)).toBe(
      false,
    );
    expect(
      evaluateLicenseExpression("MIT WITH Classpath-exception-2.0", policy),
    ).toBe(false);
    expect(evaluateLicenseExpression("UNKNOWN", policy)).toBe(false);
    expect(() => evaluateLicenseExpression("MIT OR", policy)).toThrow(
      /invalid SPDX expression/iu,
    );
  });

  it("defines reviewed policy metadata and no permanent package exceptions", () => {
    expect(policy.schemaVersion).toBe(1);
    expect(policy.owner).toBe("Humans maintainers");
    expect(policy.allowedLicenses).toEqual(
      expect.objectContaining({
        "Apache-2.0": expect.any(String),
        MIT: expect.any(String),
      }),
    );
    expect(policy.exceptions).toEqual([]);
  });

  it("passes the repository's installed production dependency graph", () => {
    const result = spawnSync(
      "node",
      ["scripts/check-dependency-licenses.mjs"],
      { cwd: process.cwd(), encoding: "utf8", shell: false },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/approved \d+ production package versions/u);
  });
});
