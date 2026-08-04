// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createInvitationHandoffHandlers,
  createInvitationHandoffRoute,
} from "@/app/api/account/invitations/handoff/route";
import {
  openInvitationHandoff,
  sealInvitationHandoff,
} from "@/modules/auth/invitation-handoff";

const encryptionKey = "71".repeat(32);
const invitationId = "018f0000-0000-7000-8000-000000000001";
const origin = "https://humans.example.test";

describe("invitation handoff", () => {
  it("seals an expiring opaque credential and rejects tampering", () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const token = sealInvitationHandoff({ encryptionKey, invitationId, now });
    expect(token).not.toContain(invitationId);
    expect(openInvitationHandoff({ encryptionKey, token, now })).toBe(
      invitationId,
    );
    expect(() =>
      openInvitationHandoff({
        encryptionKey,
        token,
        now: new Date(now.getTime() + 16 * 60_000),
      }),
    ).toThrow();
    expect(() =>
      openInvitationHandoff({ encryptionKey, token: `${token}x`, now }),
    ).toThrow();
  });

  it("uses a Strict HttpOnly cookie and returns the ID only to a live session", async () => {
    const handlers = createInvitationHandoffHandlers({
      encryptionKey,
      getSession: async () => ({ user: { id: "user" } }),
      secureCookies: true,
      trustedOrigins: [origin],
    });
    const established = await handlers.POST(
      new Request(`${origin}/api/account/invitations/handoff`, {
        body: JSON.stringify({ invitationId }),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      }),
    );
    expect(established.status).toBe(200);
    const cookie = established.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly.*SameSite=Strict.*Secure/u);
    expect(cookie).not.toContain(invitationId);
    const opened = await handlers.GET(
      new Request(`${origin}/api/account/invitations/handoff`, {
        headers: { cookie: cookie.split(";", 1)[0]! },
      }),
    );
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({ invitationId });
  });

  it("contains shared loader failures and retries rejected initialization", async () => {
    const successful = createInvitationHandoffHandlers({
      encryptionKey,
      getSession: async () => null,
      secureCookies: false,
      trustedOrigins: [origin],
    });
    const loader = vi
      .fn<() => Promise<typeof successful>>()
      .mockRejectedValueOnce(new Error("loader secret"))
      .mockResolvedValue(successful);
    const route = createInvitationHandoffRoute("GET", loader);
    const [first, shared] = await Promise.all([
      route(new Request(`${origin}/api/account/invitations/handoff`)),
      route(new Request(`${origin}/api/account/invitations/handoff`)),
    ]);
    expect(first.status).toBe(503);
    expect(shared.status).toBe(503);
    expect(await first.text()).not.toContain("secret");
    const retry = await route(
      new Request(`${origin}/api/account/invitations/handoff`),
    );
    expect(retry.status).toBe(401);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
