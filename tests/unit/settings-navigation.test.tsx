import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/settings/account" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { SettingsNavigation } from "@/components/settings/settings-navigation";

describe("SettingsNavigation", () => {
  beforeEach(() => {
    navigation.pathname = "/settings/account";
  });

  it("renders responsive semantic navigation with exact active-route state", () => {
    const { container } = render(<SettingsNavigation canAdministerWorkspace />);

    expect(screen.getByRole("navigation", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const label of [
      "Security",
      "Members",
      "API keys",
      "Policies",
      "Audit",
      "Integrations",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeVisible();
    }
    expect(container.firstChild).toHaveClass("overflow-x-auto");
  });

  it("keeps personal routes available while hiding workspace administration", () => {
    render(<SettingsNavigation canAdministerWorkspace={false} />);

    expect(screen.getByRole("link", { name: "Account" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Security" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Policies" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Audit" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Integrations" })).toBeNull();
  });

  it("preserves semantic navigation in a right-to-left document subtree", () => {
    const { container } = render(
      <div dir="rtl">
        <SettingsNavigation canAdministerWorkspace />
      </div>,
    );

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav.closest("[dir='rtl']")).toBe(container.firstChild);
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
