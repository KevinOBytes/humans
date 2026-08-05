// @vitest-environment node

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import proxy from "@/proxy";

describe("middleware security envelope", () => {
  it("applies security headers to a protected route response", async () => {
    const response = proxy(
      new NextRequest("https://humans.example.test/dashboard"),
    );

    expect(response.headers.get("content-security-policy")).toContain(
      "object-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "base-uri 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("adds security headers while preserving auth-guard redirects", async () => {
    const response = proxy(
      new NextRequest("https://humans.example.test/dashboard"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/sign-in");
    expect(response.headers.get("strict-transport-security")).toBeDefined();
  });

  it("moves reset tokens to hash and keeps security headers", async () => {
    const response = proxy(
      new NextRequest("https://humans.example.test/reset-password?token=s3t"),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/reset-password");
    expect(location.hash).toBe("#token=s3t");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps loopback HTTP usable without transport-upgrade headers", () => {
    const response = proxy(new NextRequest("http://localhost:3000/dashboard"));

    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("content-security-policy")).not.toContain(
      "upgrade-insecure-requests",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "ws://localhost:*",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("does not weaken transport headers for non-loopback HTTP hosts", () => {
    const response = proxy(
      new NextRequest("http://humans.example.test/dashboard"),
    );

    expect(response.headers.get("strict-transport-security")).toContain(
      "max-age=31536000",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "upgrade-insecure-requests",
    );
  });

  it("keeps security policy on ordinary routes while API responses avoid a public cache directive", () => {
    const page = proxy(
      new NextRequest("https://humans.example.test/sign-in?returnTo=%2Fpeople"),
    );
    const api = proxy(
      new NextRequest("https://humans.example.test/api/storage/objects"),
    );

    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("permissions-policy")).toContain("camera=()");
    expect(api.headers.get("cache-control")).toBeNull();
    expect(api.headers.get("x-frame-options")).toBe("DENY");
  });
});
