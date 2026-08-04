import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  execute: vi.fn(),
  getSession: vi.fn(),
  headers: vi.fn(),
  listOrganizations: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirect:${destination}`);
  }),
}));

vi.mock("next/headers", () => ({ headers: server.headers }));
vi.mock("next/navigation", () => ({ redirect: server.redirect }));
vi.mock("server-only", () => ({}));
vi.mock("@/modules/auth/auth", () => ({
  auth: {
    api: {
      getSession: server.getSession,
      listOrganizations: server.listOrganizations,
    },
  },
}));
vi.mock("@/graphql/server-client", () => ({
  executeServerGraphQL: server.execute,
  ServerGraphQLError: class ServerGraphQLError extends Error {
    errors: { code: string }[];
    constructor(errors: { code: string }[]) {
      super("GraphQL failed");
      this.errors = errors;
    }
    hasCode(code: string) {
      return this.errors.some((error) => error.code === code);
    }
  },
}));

import { getAppContext, getVerifiedAppSession } from "@/app/(app)/app-session";

describe("authenticated app session boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.headers.mockResolvedValue(
      new Headers({ cookie: "better-auth.session_token=value" }),
    );
    server.listOrganizations.mockResolvedValue([]);
  });

  it("uses a live session read and safely redirects an unauthenticated request", async () => {
    server.getSession.mockResolvedValue(null);

    await expect(getVerifiedAppSession()).rejects.toThrow(
      "redirect:/sign-in?returnTo=%2Fdashboard",
    );
    expect(server.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true, disableRefresh: true },
    });
  });

  it("does not query research data when no active organization is present", async () => {
    server.getSession.mockResolvedValue({
      session: { activeOrganizationId: null },
      user: { id: "user-a" },
    });

    const context = await getAppContext();

    expect(context.viewer).toBeNull();
    expect(server.execute).not.toHaveBeenCalled();
  });

  it("uses the canonical GraphQL viewer when active workspace state exists", async () => {
    server.getSession.mockResolvedValue({
      session: { activeOrganizationId: "organization-a" },
      user: { id: "user-a" },
    });
    server.execute.mockResolvedValue({
      viewer: {
        workspace: { id: "workspace-a", organizationId: "organization-a" },
        permissions: ["person:read"],
      },
    });

    const context = await getAppContext();

    expect(context.viewer?.workspace.organizationId).toBe("organization-a");
    expect(server.execute).toHaveBeenCalledOnce();
  });
});
