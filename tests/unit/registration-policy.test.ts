// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  assertRegistrationAllowed,
  REGISTRATION_UNAVAILABLE_MESSAGE,
} from "@/modules/auth/registration-policy";

describe("registration policy", () => {
  it("allows public registration without consulting invitations", async () => {
    const hasPendingInvitation = vi.fn();

    await expect(
      assertRegistrationAllowed({
        email: " Person@Example.test ",
        hasPendingInvitation,
        mode: "public",
      }),
    ).resolves.toBeUndefined();
    expect(hasPendingInvitation).not.toHaveBeenCalled();
  });

  it("rejects disabled registration with the stable public response", async () => {
    await expect(
      assertRegistrationAllowed({
        email: "person@example.test",
        hasPendingInvitation: vi.fn(),
        mode: "disabled",
      }),
    ).rejects.toMatchObject({ message: REGISTRATION_UNAVAILABLE_MESSAGE });
  });

  it("requires a live same-email pending invitation without exposing lookup results", async () => {
    const hasPendingInvitation = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      assertRegistrationAllowed({
        email: " Invited@Example.test ",
        hasPendingInvitation,
        mode: "invite_only",
      }),
    ).resolves.toBeUndefined();
    expect(hasPendingInvitation).toHaveBeenNthCalledWith(
      1,
      "invited@example.test",
    );

    await expect(
      assertRegistrationAllowed({
        email: "missing@example.test",
        hasPendingInvitation,
        mode: "invite_only",
      }),
    ).rejects.toMatchObject({ message: REGISTRATION_UNAVAILABLE_MESSAGE });
  });

  it("fails closed with the same response when invitation lookup fails", async () => {
    await expect(
      assertRegistrationAllowed({
        email: "person@example.test",
        hasPendingInvitation: vi.fn().mockRejectedValue(new Error("db down")),
        mode: "invite_only",
      }),
    ).rejects.toMatchObject({ message: REGISTRATION_UNAVAILABLE_MESSAGE });
  });
});
