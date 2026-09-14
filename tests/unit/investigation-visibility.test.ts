import { describe, expect, it } from "vitest";

import { canViewInvestigation } from "@/modules/investigations/visibility";

describe("investigation visibility", () => {
  it.each([
    ["owner", "user"],
    ["admin", "user"],
  ] as const)(
    "allows workspace %s managers to view workspace investigations",
    (role, actorType) => {
      expect(
        canViewInvestigation({
          actorRole: role,
          actorType,
          hasCaseMembership: false,
          hasTeamMembership: false,
          leadPrincipalId: "lead",
          principalId: "unrelated",
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["investigation lead", { leadPrincipalId: "principal" }],
    ["linked case member", { hasCaseMembership: true }],
    ["linked team member", { hasTeamMembership: true }],
  ] as const)("allows a %s to view the investigation", (_label, override) => {
    expect(
      canViewInvestigation({
        actorRole: "analyst",
        actorType: "user",
        hasCaseMembership: false,
        hasTeamMembership: false,
        leadPrincipalId: "lead",
        principalId: "principal",
        ...override,
      }),
    ).toBe(true);
  });

  it("denies unrelated users and API-key principals even with read scope", () => {
    expect(
      canViewInvestigation({
        actorRole: "viewer",
        actorType: "user",
        hasCaseMembership: false,
        hasTeamMembership: false,
        leadPrincipalId: "lead",
        principalId: "unrelated",
      }),
    ).toBe(false);
    expect(
      canViewInvestigation({
        actorRole: null,
        actorType: "apiKey",
        hasCaseMembership: false,
        hasTeamMembership: false,
        leadPrincipalId: "lead",
        principalId: "api-key-principal",
      }),
    ).toBe(false);
  });
});
