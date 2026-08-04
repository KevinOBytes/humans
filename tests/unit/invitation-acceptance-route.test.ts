// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createInvitationAcceptanceHandler,
  createInvitationAcceptanceRoute,
} from "@/app/api/account/invitations/accept/route";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { InvitationLifecycleError } from "@/modules/auth/invitation-lifecycle";

const database = {} as Database;
const origin = "https://humans.example.test";

function request(headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/account/invitations/accept`, {
    body: JSON.stringify({ invitationId: "invitation-1" }),
    headers: { "content-type": "application/json", origin, ...headers },
    method: "POST",
  });
}

describe("atomic invitation acceptance route", () => {
  it("contains shared initialization failure and safely retries once on the next request", async () => {
    const delegated = vi.fn(async () => new Response(null, { status: 204 }));
    const loader = vi
      .fn<() => Promise<(request: Request) => Promise<Response>>>()
      .mockRejectedValueOnce(new Error("loader credential detail"))
      .mockResolvedValueOnce(delegated);
    const log = vi.fn();
    const route = createInvitationAcceptanceRoute(loader, { log });
    const headers = {
      "x-request-id": "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1",
    };

    const failures = await Promise.all([
      route(request(headers)),
      route(request(headers)),
    ]);
    expect(loader).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith({
      event: "auth.infrastructure.failure",
      requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      severity: "error",
    });
    for (const result of failures) {
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("x-request-id")).toBe(
        "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      );
      const body = await result.text();
      expect(body).not.toContain("credential detail");
      expect(JSON.parse(body)).toEqual({
        code: "INVITATION_UNAVAILABLE",
        requestId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
      });
    }

    expect((await route(request())).status).toBe(204);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(delegated).toHaveBeenCalledOnce();
  });

  it("contains delegated rejection without rebuilding an initialized handler", async () => {
    const delegated = vi.fn(async () => {
      throw new Error("handler token detail");
    });
    const loader = vi.fn(async () => delegated);
    const log = vi.fn();
    const route = createInvitationAcceptanceRoute(loader, { log });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await route(request({ "x-request-id": "malformed" }));
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
      const body = await result.text();
      expect(body).not.toContain("token detail");
      expect(JSON.parse(body)).toMatchObject({
        code: "INVITATION_UNAVAILABLE",
        requestId: result.headers.get("x-request-id"),
      });
    }
    expect(loader).toHaveBeenCalledOnce();
    expect(delegated).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("token detail");
  });

  it("requires trusted origin and a browser session and rejects API keys", async () => {
    const accept = vi.fn();
    const getSession = vi.fn(async () => ({ user: { id: "user-1" } }));
    const handler = createInvitationAcceptanceHandler({
      accept,
      database,
      getSession,
      trustedOrigins: [origin],
    });

    expect(
      (
        await handler(
          request({
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await handler(request({ authorization: "Bearer workspace-key" })))
        .status,
    ).toBe(403);
    expect(
      (await handler(request({ "x-api-key": "workspace-key" }))).status,
    ).toBe(403);
    getSession.mockResolvedValueOnce(null as never);
    expect((await handler(request())).status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it("passes only the validated invitation and session user to the transaction", async () => {
    const accept = vi.fn(async () => ({
      organizationId: "organization-1",
      workspaceId: "0198d9d9-a821-7000-8000-000000000001",
    }));
    const handler = createInvitationAcceptanceHandler({
      accept,
      database,
      getSession: async () => ({ user: { id: "user-1" } }),
      trustedOrigins: [origin],
    });

    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(accept).toHaveBeenCalledWith({
      database,
      invitationId: "invitation-1",
      userId: "user-1",
    });
  });

  it("returns one public status and shape for every domain failure while logging only a reason", async () => {
    const events: unknown[] = [];
    const requestId = "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1";
    const shapes: unknown[] = [];
    for (const code of [
      "ALREADY_MEMBER",
      "EXPIRED",
      "FORBIDDEN",
      "INVALID_ROLE",
      "NOT_FOUND",
      "UNAVAILABLE",
    ] as const) {
      const handler = createInvitationAcceptanceHandler({
        accept: async () => {
          throw new InvitationLifecycleError(code);
        },
        database,
        getSession: async () => ({ user: { id: "user-1" } }),
        securityLogger: { log: (event) => events.push(event) },
        trustedOrigins: [origin],
      });
      const result = await handler(request({ "x-request-id": requestId }));
      expect(result.status).toBe(409);
      shapes.push(await result.json());
    }
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
    expect(events).toEqual(
      [
        "ALREADY_MEMBER",
        "EXPIRED",
        "FORBIDDEN",
        "INVALID_ROLE",
        "NOT_FOUND",
        "UNAVAILABLE",
      ].map((reason) => ({
        event: "auth.invitation.acceptance_rejected",
        reason,
        requestId,
        severity: "warn",
      })),
    );
    expect(JSON.stringify(events)).not.toMatch(/invitation-1|user-1/iu);
  });
});
