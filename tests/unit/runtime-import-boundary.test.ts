import { afterEach, describe, expect, it, vi } from "vitest";

describe("request-time runtime initialization", () => {
  afterEach(() => {
    vi.doUnmock("server-only");
    vi.doUnmock("@/db/client");
    vi.doUnmock("@/modules/auth/auth");
    vi.resetModules();
  });

  it("loads protected app modules without initializing auth or the database", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/db/client", () => {
      throw new Error("database runtime initialized during module loading");
    });
    vi.doMock("@/modules/auth/auth", () => {
      throw new Error("auth runtime initialized during module loading");
    });

    await expect(
      Promise.all([
        import("@/app/(app)/app-session"),
        import("@/app/(app)/workspace-actions"),
        import("@/app/(app)/settings/members/page"),
        import("@/app/api/graphql/route"),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        getAppContext: expect.any(Function),
        getVerifiedAppSession: expect.any(Function),
      }),
      expect.objectContaining({ createWorkspace: expect.any(Function) }),
      expect.objectContaining({ default: expect.any(Function) }),
      expect.objectContaining({ POST: expect.any(Function) }),
    ]);
  });
});
