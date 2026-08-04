import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceSwitcher } from "@/components/workspace-switcher";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const workspaces = [
  { id: "workspace-a", name: "Archive desk" },
  { id: "workspace-b", name: "Field team" },
] as const;

describe("WorkspaceSwitcher", () => {
  it("keeps the verified workspace visible until activation succeeds", async () => {
    const user = userEvent.setup();
    const request = deferred<{ error?: unknown }>();
    const activateWorkspace = vi.fn(() => request.promise);
    const navigate = vi.fn();
    render(
      <WorkspaceSwitcher
        activeWorkspace={workspaces[0]}
        organizations={workspaces}
        activateWorkspace={activateWorkspace}
        navigate={navigate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /archive desk/i }));
    await user.click(screen.getByRole("menuitem", { name: "Field team" }));
    expect(screen.getByRole("button", { name: /archive desk/i })).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();

    request.resolve({});
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
  });

  it("retains the current workspace and announces activation failure", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSwitcher
        activeWorkspace={workspaces[0]}
        organizations={workspaces}
        activateWorkspace={vi.fn().mockResolvedValue({ error: "denied" })}
        navigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /archive desk/i }));
    await user.click(screen.getByRole("menuitem", { name: "Field team" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not switch workspaces/i,
    );
    expect(screen.getByRole("button", { name: /archive desk/i })).toBeVisible();
  });
});
