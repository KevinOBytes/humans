import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemberAdministration } from "@/components/settings/member-administration";
import {
  IssueWorkspaceInvitationDocument,
  SettingsWorkspaceDirectoryDocument,
} from "@/graphql/generated/graphql";

const execute = vi.fn();
vi.mock("@/graphql/client", () => ({
  executeBrowserGraphQL: (...args: unknown[]) => execute(...args),
}));

describe("member administration", () => {
  beforeEach(() => execute.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("threads an abort signal through the directory request and aborts on disposal", async () => {
    execute.mockImplementation(
      (
        _document: unknown,
        _variables: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        const signal = options?.signal;
        if (!signal)
          return Promise.resolve({
            ok: false,
            errors: [{ code: "NETWORK_ERROR", message: "missing signal" }],
          });
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                ok: false,
                errors: [{ code: "NETWORK_ERROR", message: "aborted" }],
              }),
            { once: true },
          );
        });
      },
    );
    const view = render(<MemberAdministration />);

    await waitFor(() =>
      expect(execute.mock.calls.some((call) => call[2]?.signal)).toBe(true),
    );
    const signal = execute.mock.calls.find((call) => call[2]?.signal)?.[2]
      ?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("reissues an expired invitation through the normal issue flow", async () => {
    execute
      .mockResolvedValueOnce({
        ok: true,
        data: {
          settingsWorkspaceDirectory: {
            actorRole: "OWNER",
            invitations: [
              {
                actionId: "01984e93-7644-72c6-82d0-fda7f590580e",
                email: "expired@example.test",
                expiresAt: "2020-01-01T00:00:00.000Z",
                role: "VIEWER",
                status: "EXPIRED",
              },
            ],
            members: {
              hasMore: false,
              hasPrevious: false,
              limit: 25,
              nodes: [],
              offset: 0,
              total: 0,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { issueWorkspaceInvitation: { code: "APPLIED" } },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          settingsWorkspaceDirectory: {
            actorRole: "OWNER",
            invitations: [],
            members: {
              hasMore: false,
              hasPrevious: false,
              limit: 25,
              nodes: [],
              offset: 0,
              total: 0,
            },
          },
        },
      });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<MemberAdministration />);

    await screen.findByRole("button", { name: "Re-invite" });
    await user.click(screen.getByRole("button", { name: "Re-invite" }));

    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        IssueWorkspaceInvitationDocument,
        expect.objectContaining({
          input: expect.objectContaining({
            email: "expired@example.test",
            role: "VIEWER",
          }),
        }),
      ),
    );
    expect(
      execute.mock.calls.some(
        (call) => call[0] === SettingsWorkspaceDirectoryDocument,
      ),
    ).toBe(true);
  });
});
