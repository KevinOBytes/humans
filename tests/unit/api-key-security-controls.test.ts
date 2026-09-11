import { describe, expect, it } from "vitest";

import {
  evaluateApiKeySecurity,
  parseApiKeyScopes,
} from "@/modules/settings/api-key-action-id";

describe("API key security controls", () => {
  it("fails closed for tenant, expiry, revocation, scope, and rate-limit failures", () => {
    expect(
      evaluateApiKeySecurity({
        enabled: true,
        workspaceId: "a",
        requestWorkspaceId: "b",
        scopes: [],
      }).code,
    ).toBe("tenant_mismatch");
    expect(
      evaluateApiKeySecurity({
        enabled: true,
        workspaceId: "a",
        requestWorkspaceId: "a",
        scopes: ["person:read"],
        requiredScopes: ["person:write"],
      }).code,
    ).toBe("scope_denied");
    expect(
      evaluateApiKeySecurity({
        enabled: true,
        workspaceId: "a",
        requestWorkspaceId: "a",
        scopes: [],
        rateLimit: { remaining: 0, resetAt: "2030-01-01" },
      }).code,
    ).toBe("rate_limited");
  });
  it("normalizes only safe, deduplicated scope names", () => {
    expect(
      parseApiKeyScopes("person:read, person:read audit:read \u0000bad"),
    ).toEqual(["audit:read", "person:read"]);
  });
});
