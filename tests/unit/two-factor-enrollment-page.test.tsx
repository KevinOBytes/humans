import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  getSession: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`redirect:${destination}`);
  }),
}));

vi.mock("next/headers", () => ({ headers: server.headers }));
vi.mock("next/navigation", () => ({ redirect: server.redirect }));
vi.mock("@/modules/auth/auth", () => ({
  auth: { api: { getSession: server.getSession } },
}));

import TwoFactorEnrollmentPage from "@/app/(auth)/two-factor/enroll/page";

describe("two-factor enrollment server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authoritatively checks the uncached session and redirects guests", async () => {
    const requestHeaders = new Headers({ cookie: "session=untrusted" });
    server.headers.mockResolvedValue(requestHeaders);
    server.getSession.mockResolvedValue(null);

    await expect(TwoFactorEnrollmentPage()).rejects.toThrow(
      "redirect:/sign-in?returnTo=%2Ftwo-factor%2Fenroll",
    );
    expect(server.getSession).toHaveBeenCalledWith({
      headers: requestHeaders,
      query: { disableCookieCache: true, disableRefresh: true },
    });
  });

  it("passes authoritative two-factor state to the client enrollment view", async () => {
    const requestHeaders = new Headers({ cookie: "session=trusted" });
    server.headers.mockResolvedValue(requestHeaders);
    server.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1", twoFactorEnabled: true },
    });

    const result = await TwoFactorEnrollmentPage();

    expect(result.props.twoFactorEnabled).toBe(true);
    expect(server.redirect).not.toHaveBeenCalled();
  });
});
