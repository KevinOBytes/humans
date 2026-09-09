// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  disable: vi.fn(),
  enable: vi.fn(),
  generateBackupCodes: vi.fn(),
  verifyTotp: vi.fn(),
}));

vi.mock("@/modules/auth/auth-client", () => ({
  authClient: {
    twoFactor: {
      disable: auth.disable,
      enable: auth.enable,
      generateBackupCodes: auth.generateBackupCodes,
      verifyTotp: auth.verifyTotp,
    },
  },
}));

import TwoFactorEnrollment from "@/app/(auth)/two-factor/enroll/two-factor-enrollment";

describe("enabled two-factor management", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rotates backup codes behind password reauthentication and acknowledgement", async () => {
    auth.generateBackupCodes.mockResolvedValue({
      data: { backupCodes: ["one-time-a", "one-time-b"] },
      error: null,
    });
    render(<TwoFactorEnrollment twoFactorEnabled />);

    await userEvent.type(
      screen.getByLabelText("Current password"),
      "correct horse battery staple",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate new backup codes" }),
    );

    expect(auth.generateBackupCodes).toHaveBeenCalledWith({
      password: "correct horse battery staple",
    });
    expect(screen.getByText("one-time-a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
  });

  it("delegates password-confirmed disablement and requires fresh authentication", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ status: true }));
    const navigate = vi.fn();
    render(<TwoFactorEnrollment twoFactorEnabled navigate={navigate} />);

    await userEvent.type(
      screen.getByLabelText("Current password"),
      "correct horse battery staple",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Disable two-step verification" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/two-factor/disable",
      expect.objectContaining({ method: "POST" }),
    );
    expect(navigate).toHaveBeenCalledWith("/sign-in?securityChanged=true");
  });

  it("removes the QR and manual secret immediately after TOTP verification", async () => {
    auth.enable.mockResolvedValue({
      data: {
        totpURI:
          "otpauth://totp/Humans:test?secret=ABCDEFGHIJKLMNOP&issuer=Humans",
        backupCodes: ["backup-one", "backup-two"],
      },
      error: null,
    });
    auth.verifyTotp.mockResolvedValue({
      data: { token: "ignored" },
      error: null,
    });
    render(<TwoFactorEnrollment twoFactorEnabled={false} />);

    await userEvent.type(screen.getByLabelText("Current password"), "password");
    await userEvent.click(
      screen.getByRole("button", { name: "Begin secure setup" }),
    );
    expect(screen.getByText("ABCDEFGHIJKLMNOP")).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Authentication code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and enable" }),
    );

    expect(screen.queryByText("ABCDEFGHIJKLMNOP")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /scan this qr/iu })).toBeNull();
    expect(screen.getByText("backup-one")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finish/iu })).toBeDisabled();
  });

  it("wipes the QR and backup-code presentation after explicit finish", async () => {
    auth.enable.mockResolvedValue({
      data: {
        totpURI:
          "otpauth://totp/Humans:finish-test?secret=FINISHSECRET&issuer=Humans",
        backupCodes: ["finish-backup-one", "finish-backup-two"],
      },
      error: null,
    });
    auth.verifyTotp.mockResolvedValue({
      data: { token: "ignored" },
      error: null,
    });
    const navigate = vi.fn();
    render(
      <TwoFactorEnrollment twoFactorEnabled={false} navigate={navigate} />,
    );

    await userEvent.type(screen.getByLabelText("Current password"), "password");
    await userEvent.click(
      screen.getByRole("button", { name: "Begin secure setup" }),
    );
    await userEvent.type(
      screen.getByLabelText("Authentication code"),
      "123456",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Verify and enable" }),
    );
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: /saved my codes/i }),
    );

    expect(navigate).toHaveBeenCalledWith("/dashboard");
    expect(screen.queryByText("FINISHSECRET")).not.toBeInTheDocument();
    expect(screen.queryByText("finish-backup-one")).not.toBeInTheDocument();
    expect(screen.queryByText("finish-backup-two")).not.toBeInTheDocument();
  });
});
