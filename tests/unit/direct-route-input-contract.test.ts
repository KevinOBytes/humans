// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createInvitationAcceptanceHandler } from "@/app/api/account/invitations/accept/handlers";
import { createInvitationHandoffHandlers } from "@/app/api/account/invitations/handoff/handlers";
import { createTwoFactorDisableHandler } from "@/app/api/account/two-factor/disable/handlers";
import type { Database } from "@/modules/auth/bootstrap-admin";

const origin = "https://humans.example";
const database = {} as Database;
const requestId = "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1";

describe("direct JSON route input and authorization envelopes", () => {
  for (const name of ["accept", "handoff", "two-factor"] as const) {
    for (const failure of [
      "malformed",
      "schema",
      "origin",
      "api-key",
    ] as const) {
      it(`${name} contains ${failure} failures without executing mutations`, async () => {
        const mutation = vi.fn();
        const getSession = vi.fn(async () => ({
          user: { id: "synthetic-user" },
        }));
        const dependencies = { database, getSession, trustedOrigins: [origin] };
        const handler =
          name === "accept"
            ? createInvitationAcceptanceHandler({
                ...dependencies,
                accept: mutation,
              })
            : name === "two-factor"
              ? createTwoFactorDisableHandler({
                  ...dependencies,
                  change: mutation,
                })
              : createInvitationHandoffHandlers({
                  ...dependencies,
                  encryptionKey: "71".repeat(32),
                  secureCookies: true,
                }).POST;
        const headers = {
          origin: failure === "origin" ? "https://untrusted.example" : origin,
          "x-request-id": requestId,
          "content-type": "application/json",
          ...(failure === "api-key" ? { "x-api-key": "private-secret" } : {}),
        };
        const response = await handler(
          new Request(`${origin}/api/account/${name}`, {
            method: "POST",
            headers,
            body:
              failure === "malformed"
                ? '{"password":"private-secret"'
                : JSON.stringify({ private: "private-secret" }),
          }),
        );
        const denied = failure === "origin" || failure === "api-key";
        expect(response.status).toBe(denied ? 403 : 400);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-request-id")).toBe(requestId);
        expect(await response.json()).toEqual({
          code: denied ? "FORBIDDEN" : "INVALID_INPUT",
          message: denied
            ? "This request is not permitted."
            : "The request is invalid.",
          requestId,
        });
        expect(mutation).not.toHaveBeenCalled();
        if (denied) expect(getSession).not.toHaveBeenCalled();
      });
    }
  }

  for (const name of ["accept", "two-factor"] as const) {
    it(`${name} rejects an unauthenticated browser request before any mutation`, async () => {
      const mutation = vi.fn();
      const getSession = vi.fn(async () => null);
      const dependencies = { database, getSession, trustedOrigins: [origin] };
      const handler =
        name === "accept"
          ? createInvitationAcceptanceHandler({
              ...dependencies,
              accept: mutation,
            })
          : createTwoFactorDisableHandler({
              ...dependencies,
              change: mutation,
            });
      const body =
        name === "accept"
          ? { invitationId: "pending-invitation" }
          : { action: "disable", password: "private-password" };

      const response = await handler(
        new Request(`${origin}/api/account/${name}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            "x-request-id": requestId,
          },
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-request-id")).toBe(requestId);
      expect(await response.json()).toEqual({
        code: "UNAUTHORIZED",
        message: "Authentication is required.",
        requestId,
      });
      expect(mutation).not.toHaveBeenCalled();
    });
  }

  it("handoff GET rejects an unauthenticated request without disclosing cookie state", async () => {
    const getSession = vi.fn(async () => null);
    const handler = createInvitationHandoffHandlers({
      encryptionKey: "71".repeat(32),
      getSession,
      secureCookies: true,
      trustedOrigins: [origin],
    }).GET;
    const response = await handler(
      new Request(`${origin}/api/account/invitations/handoff`, {
        headers: { "x-request-id": requestId },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(await response.json()).toEqual({
      code: "UNAUTHORIZED",
      message: "Authentication is required.",
      requestId,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
