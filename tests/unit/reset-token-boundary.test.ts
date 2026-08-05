// @vitest-environment node

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { routeProxy as proxy } from "@/route-proxy";

describe("password reset token rendering boundary", () => {
  it("moves the action token to a client-only fragment before rendering", async () => {
    const token = "sensitive-reset-action-token";
    const response = proxy(
      new NextRequest(
        `https://humans.example.test/reset-password?token=${token}`,
      ),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location")!;
    expect(new URL(location).pathname).toBe("/reset-password");
    expect(new URL(location).search).toBe("");
    expect(new URL(location).hash).toBe(`#token=${token}`);
    expect(await response.text()).not.toContain(token);
  });
});

describe("invitation credential rendering boundary", () => {
  it("moves the opaque invitation ID to a client-only fragment", async () => {
    const id = "018f0000-0000-7000-8000-000000000001";
    const response = proxy(
      new NextRequest(`https://humans.example.test/accept-invitation?id=${id}`),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/accept-invitation");
    expect(location.search).toBe("");
    expect(location.hash).toBe(`#id=${id}`);
    expect(await response.text()).not.toContain(id);
  });
});
