// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import proxy from "@/proxy";

const appRoot = resolve("src/app");

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function apiRoutePath(file: string): string {
  const relativePath = relative(appRoot, dirname(file));
  const segments = relativePath.split(sep).filter(Boolean);
  return `/${segments
    .filter((segment) => !/^\([^)]*\)$/u.test(segment))
    .map((segment) => {
      if (segment.startsWith("[...")) return "fixture";
      if (segment.startsWith("[") && segment.endsWith("]")) {
        return "fixture";
      }
      return segment;
    })
    .join("/")}`;
}

function apiRouteFiles(): string[] {
  return filesUnder(resolve(appRoot, "api"))
    .filter((file) => file.endsWith("/route.ts"))
    .sort();
}

function methodSource(source: string, method: string): string {
  const start = source.indexOf(`${method}(`);
  if (start < 0) return "";
  const nextMethods = [
    "\n  async ",
    "\n  checkReachability",
    "\n  getMetadata",
    "\n  openRead",
    "\n  exists",
    "\n  delete(",
  ]
    .map((candidate) => source.indexOf(candidate, start + method.length + 1))
    .filter((index) => index >= 0);
  const end = nextMethods.length > 0 ? Math.min(...nextMethods) : source.length;
  return source.slice(start, end);
}

describe("HUM-NFR-006 repository security contract", () => {
  it("applies browser security headers to every discovered API route", () => {
    const routes = apiRouteFiles();
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const path = apiRoutePath(route);
      const response = proxy(
        new NextRequest(`https://humans.example.test${path}`),
      );

      expect(response.headers.get("content-security-policy"), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("content-security-policy"), path).toContain(
        "object-src 'none'",
      );
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("x-content-type-options"), path).toBe(
        "nosniff",
      );
      expect(response.headers.get("cross-origin-opener-policy"), path).toBe(
        "same-origin",
      );
      expect(response.headers.get("cross-origin-resource-policy"), path).toBe(
        "same-origin",
      );
      expect(response.headers.get("referrer-policy"), path).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(response.headers.get("permissions-policy"), path).toContain(
        "camera=()",
      );
      expect(response.headers.get("strict-transport-security"), path).toContain(
        "max-age=31536000",
      );
      expect(response.headers.get("cache-control"), path).toBeNull();
    }
  });

  it("keeps every concrete object-store adapter behind input and filename validators", () => {
    const adapters = filesUnder(resolve("src/lib/storage"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith("/types.ts"))
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => source.includes("implements ObjectStore"));

    expect(adapters.length).toBeGreaterThan(0);
    for (const { file, source } of adapters) {
      const createUpload = methodSource(source, "createUpload");
      const createDownload = methodSource(source, "createDownload");

      expect(createUpload, file).toBeTruthy();
      expect(createUpload, file).toContain("validateUpload");
      expect(createDownload, file).toBeTruthy();
      expect(createDownload, file).toContain("validateFileName");
    }
  });
});
