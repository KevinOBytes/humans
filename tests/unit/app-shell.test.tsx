import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/app-shell";

const baseProps = {
  activeWorkspace: { id: "workspace-a", name: "Archive desk" },
  organizations: [
    { id: "workspace-a", name: "Archive desk" },
    { id: "workspace-b", name: "Field team" },
  ],
  viewer: {
    displayName: "Ada Owner",
    email: "ada@example.test",
    permissions: ["person:read", "person:create"],
    role: "owner",
  },
} as const;

describe("AppShell", () => {
  it("renders one main landmark, skip navigation, and only permitted destinations", () => {
    render(<AppShell {...baseProps}>Research content</AppShell>);

    expect(
      screen.getByRole("link", { name: "Skip to content" }),
    ).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("Research content");
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeVisible();
    expect(screen.getByRole("link", { name: "People" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Add person" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /graph|search|imports/i }),
    ).toBeNull();
  });

  it("opens keyboard-safe mobile navigation and returns focus on Escape", async () => {
    const user = userEvent.setup();
    render(<AppShell {...baseProps}>Research content</AppShell>);
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toBeVisible();
    expect(
      within(dialog).getByText("Archive desk", { exact: true }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Workspace: Archive desk" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens a local-only command dialog with Ctrl or Command K", async () => {
    render(<AppShell {...baseProps}>Research content</AppShell>);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(
      await screen.findByRole("dialog", { name: "Go to or run a command" }),
    ).toBeVisible();
    const dialog = screen.getByRole("dialog", {
      name: "Go to or run a command",
    });
    expect(within(dialog).getByRole("link", { name: "People" })).toBeVisible();
    expect(
      within(dialog).queryByPlaceholderText(/search people|research/i),
    ).toBeNull();
  });

  it("exposes Graph only when all composed read permissions are present", () => {
    const { rerender } = render(
      <AppShell {...baseProps}>Research content</AppShell>,
    );
    expect(
      screen.queryByRole("link", { name: "Graph" }),
    ).not.toBeInTheDocument();

    rerender(
      <AppShell
        {...baseProps}
        viewer={{
          ...baseProps.viewer,
          permissions: [
            ...baseProps.viewer.permissions,
            "graph:read",
            "relationship:read",
          ],
        }}
      >
        Research content
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Graph" })).toHaveAttribute(
      "href",
      "/graph",
    );
  });
});
