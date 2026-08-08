import { describe, expect, it } from "vitest";

import {
  returnToFromSearch,
  twoFactorRedirectPath,
} from "@/modules/auth/return-to";

describe("auth return paths", () => {
  it("allows the caller to choose a safe default destination", () => {
    expect(returnToFromSearch("", "/dashboard")).toBe("/dashboard");
    expect(returnToFromSearch("?returnTo=%2Fgraph", "/dashboard")).toBe(
      "/graph",
    );
    expect(twoFactorRedirectPath("", "/dashboard")).toBe(
      "/two-factor?returnTo=%2Fdashboard",
    );
  });

  it("preserves only the clean invitation continuation", () => {
    const invitation = "/accept-invitation";
    const search = `?returnTo=${encodeURIComponent(invitation)}`;

    expect(returnToFromSearch(search)).toBe(invitation);
    expect(twoFactorRedirectPath(search)).toBe(
      `/two-factor?returnTo=${encodeURIComponent(invitation)}`,
    );
  });

  it("rejects invitation credentials embedded in return targets", () => {
    const invitation = "/accept-invitation?id=invitation-123";
    expect(
      returnToFromSearch(`?returnTo=${encodeURIComponent(invitation)}`),
    ).toBe("/");
  });

  it.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/\\attacker.example/steal",
    "javascript:alert(1)",
    "data:text/html,attack",
    "",
  ])("fails unsafe return target %j closed to the home route", (candidate) => {
    const search = `?returnTo=${encodeURIComponent(candidate)}`;

    expect(returnToFromSearch(search)).toBe("/");
    expect(twoFactorRedirectPath(search)).toBe(
      `/two-factor?returnTo=${encodeURIComponent("/")}`,
    );
  });
});
