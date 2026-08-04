import { describe, expect, it } from "vitest";

import {
  canInviteRole,
  canManageMember,
} from "@/modules/settings/member-policy";

describe("workspace member administration policy", () => {
  it("disallows owner invitations and restricts administrators to lower roles", () => {
    expect(canInviteRole("owner", "admin")).toBe(true);
    expect(canInviteRole("owner", "owner")).toBe(false);
    expect(canInviteRole("admin", "viewer")).toBe(true);
    expect(canInviteRole("admin", "admin")).toBe(false);
    expect(canInviteRole("viewer", "viewer")).toBe(false);
  });

  it("denies self-action and prevents administrators acting on peers or owners", () => {
    expect(
      canManageMember({
        actorRole: "owner",
        actorUserId: "actor",
        targetRole: "admin",
        targetUserId: "actor",
      }),
    ).toBe(false);
    expect(
      canManageMember({
        actorRole: "admin",
        actorUserId: "actor",
        targetRole: "admin",
        targetUserId: "peer",
      }),
    ).toBe(false);
    expect(
      canManageMember({
        actorRole: "admin",
        actorUserId: "actor",
        targetRole: "viewer",
        targetUserId: "target",
        nextRole: "admin",
      }),
    ).toBe(false);
  });
});
