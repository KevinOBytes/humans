// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("@/modules/auth/auth-client", () => ({
  authClient: { signOut },
}));

import { SignOutControl } from "@/components/auth/sign-out-control";

describe("SignOutControl", () => {
  beforeEach(() => signOut.mockReset());

  it("revokes the session and uses a fixed sign-in destination", async () => {
    signOut.mockResolvedValue({ data: { success: true }, error: null });
    const navigate = vi.fn();
    render(<SignOutControl navigate={navigate} />);

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/sign-in?signedOut=true");
  });

  it("keeps the user in place and announces failure when revocation fails", async () => {
    signOut.mockResolvedValue({ data: null, error: { message: "failed" } });
    const navigate = vi.fn();
    render(<SignOutControl navigate={navigate} />);

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "We couldn't sign you out",
    );
  });
});
