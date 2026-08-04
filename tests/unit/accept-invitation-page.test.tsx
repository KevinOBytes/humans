import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getInvitation: vi.fn(),
  setActive: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock("@/components/auth/use-location-search", () => ({
  useEphemeralHashParam: () => ({
    ready: true,
    value: "018f0000-0000-7000-8000-000000000001",
  }),
}));
vi.mock("@/modules/auth/auth-client", () => ({
  authClient: {
    organization: {
      getInvitation: client.getInvitation,
      setActive: client.setActive,
    },
    signOut: client.signOut,
    useSession: client.useSession,
  },
}));

import AcceptInvitationPage from "@/app/(auth)/accept-invitation/page";

describe("invitation acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.useSession.mockReturnValue({
      data: {
        user: {
          email: "member@example.com",
          emailVerified: true,
        },
      },
      isPending: false,
    });
    client.getInvitation.mockResolvedValue({
      data: {
        id: "018f0000-0000-7000-8000-000000000001",
        email: "member@example.com",
        role: "viewer",
        organizationId: "organization-1",
        organizationName: "Research team",
        inviterEmail: "owner@example.com",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      error: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: true }))),
    );
    client.setActive.mockResolvedValue({
      data: { id: "organization-1" },
      error: null,
    });
  });

  it("does not report success when selecting the accepted workspace fails", async () => {
    client.setActive.mockResolvedValue({
      data: null,
      error: { message: "Workspace activation failed" },
    });
    render(<AcceptInvitationPage />);

    const accept = await screen.findByRole("button", {
      name: "Accept invitation",
    });
    await userEvent.click(accept);

    await waitFor(() => {
      expect(client.setActive).toHaveBeenCalledWith({
        organizationId: "organization-1",
      });
    });
    expect(
      screen.queryByRole("heading", { name: "You joined the workspace" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't activate the workspace/i)).toBeVisible();
    expect(screen.getByText(/invitation was accepted/i)).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/api/account/invitations/accept", {
      body: JSON.stringify({
        invitationId: "018f0000-0000-7000-8000-000000000001",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });

  it("stores the fragment credential only in a sealed server handoff before use", async () => {
    render(<AcceptInvitationPage />);
    await screen.findByRole("button", { name: "Accept invitation" });
    expect(fetch).toHaveBeenCalledWith("/api/account/invitations/handoff", {
      body: JSON.stringify({
        invitationId: "018f0000-0000-7000-8000-000000000001",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(document.body.innerHTML).not.toContain("018f0000");
  });

  it("reports success only after the accepted workspace becomes active", async () => {
    render(<AcceptInvitationPage />);

    const accept = await screen.findByRole("button", {
      name: "Accept invitation",
    });
    await userEvent.click(accept);

    expect(
      await screen.findByRole("heading", { name: "You joined the workspace" }),
    ).toBeVisible();
    expect(client.setActive).toHaveBeenCalledWith({
      organizationId: "organization-1",
    });
  });
});
