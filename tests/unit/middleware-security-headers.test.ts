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
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
