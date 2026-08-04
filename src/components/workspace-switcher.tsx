"use client";

import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";

import type { WorkspaceOption } from "@/components/research/types";
import { authClient } from "@/modules/auth/auth-client";

export type WorkspaceSwitcherProps = {
  activeWorkspace: WorkspaceOption;
  organizations: readonly WorkspaceOption[];
  activateWorkspace?: (organizationId: string) => Promise<{
    error?: unknown;
  }>;
  navigate?: (href: string) => void;
};

export function WorkspaceSwitcher({
  activeWorkspace,
  organizations,
  activateWorkspace = async (organizationId) => {
    const result = await authClient.organization.setActive({ organizationId });
    return { error: result.error };
  },
  navigate = (href) => window.location.assign(href),
}: WorkspaceSwitcherProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function selectWorkspace(id: string) {
    if (id === activeWorkspace.id || pendingId) return;
    setPendingId(id);
    setError(null);
    try {
      const result = await activateWorkspace(id);
      if (result.error) {
        setError(
          "We could not switch workspaces. Your current workspace is unchanged.",
        );
        return;
      }
      navigate("/dashboard");
    } catch {
      setError(
        "We could not switch workspaces. Your current workspace is unchanged.",
      );
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="min-w-0">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Workspace: ${activeWorkspace.name}`}
            className="border-border bg-card hover:bg-muted focus-visible:ring-ring flex min-h-11 max-w-full items-center gap-2 rounded-xl border px-3 text-left text-sm font-semibold outline-none focus-visible:ring-2"
          >
            <span className="truncate">{activeWorkspace.name}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="border-border bg-popover text-popover-foreground z-[60] min-w-56 rounded-xl border p-1.5 shadow-xl"
          >
            <DropdownMenu.Label className="text-muted-foreground px-3 py-2 text-xs font-semibold uppercase">
              Workspaces
            </DropdownMenu.Label>
            <DropdownMenu.Group>
              {organizations.map((workspace) => (
                <DropdownMenu.Item
                  key={workspace.id}
                  disabled={
                    pendingId !== null || workspace.id === activeWorkspace.id
                  }
                  onSelect={() => void selectWorkspace(workspace.id)}
                  className="focus:bg-muted flex min-h-10 cursor-pointer items-center rounded-lg px-3 text-sm outline-none data-[disabled]:opacity-50"
                >
                  {pendingId === workspace.id
                    ? `Switching to ${workspace.name}…`
                    : workspace.name}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {error ? (
        <p role="alert" className="text-destructive mt-2 max-w-xs text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
