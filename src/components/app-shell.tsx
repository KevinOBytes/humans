import type { ReactNode } from "react";

import {
  HumansMark,
  MobileNavigation,
  NavigationLinks,
} from "@/components/app-navigation";
import { CommandMenu } from "@/components/command-menu";
import { SignOutControl } from "@/components/auth/sign-out-control";
import type {
  ViewerSummary,
  WorkspaceOption,
} from "@/components/research/types";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

export type AppShellProps = {
  activeWorkspace: WorkspaceOption;
  children: ReactNode;
  organizations: readonly WorkspaceOption[];
  viewer: ViewerSummary;
};

export function AppShell({
  activeWorkspace,
  children,
  organizations,
  viewer,
}: AppShellProps) {
  const canCreatePerson = viewer.permissions.includes("person:create");
  const canViewAnalyst = viewer.permissions.includes("analysis:read");
  const canViewEvidence = viewer.permissions.includes("file:read");
  const canViewImports = viewer.permissions.includes("import:read");
  const canViewSearch = viewer.permissions.includes("search:read");
  const canViewGraph = ["graph:read", "person:read", "relationship:read"].every(
    (permission) => viewer.permissions.includes(permission),
  );
  return (
    <div className="bg-background text-foreground min-h-svh">
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground fixed top-3 left-3 z-50 -translate-y-24 rounded-lg px-4 py-2 text-sm font-semibold focus:translate-y-0"
      >
        Skip to content
      </a>
      <div className="mx-auto grid min-h-svh max-w-[1680px] lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="border-border bg-card/70 hidden border-r px-5 py-6 lg:flex lg:flex-col">
          <HumansMark />
          <div className="mt-8">
            <WorkspaceSwitcher
              activeWorkspace={activeWorkspace}
              organizations={organizations}
            />
          </div>
          <div className="mt-8">
            <NavigationLinks
              canViewAnalyst={canViewAnalyst}
              canCreatePerson={canCreatePerson}
              canViewEvidence={canViewEvidence}
              canViewGraph={canViewGraph}
              canViewImports={canViewImports}
              canViewSearch={canViewSearch}
            />
          </div>
          <div className="border-border mt-auto border-t pt-5">
            <p className="truncate text-sm font-semibold">
              {viewer.displayName}
            </p>
            <p className="text-muted-foreground mt-1 truncate text-xs">
              {viewer.email}
            </p>
            <p className="text-primary mt-2 text-xs font-medium capitalize">
              {viewer.role}
            </p>
            <div className="mt-3">
              <SignOutControl />
            </div>
          </div>
        </aside>
        <div className="min-w-0">
          <header className="border-border bg-background/90 sticky top-0 z-20 flex min-h-16 items-center justify-between gap-3 border-b px-4 backdrop-blur-xl sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-2 lg:hidden">
              <MobileNavigation
                activeWorkspace={activeWorkspace}
                canViewAnalyst={canViewAnalyst}
                canCreatePerson={canCreatePerson}
                canViewEvidence={canViewEvidence}
                canViewGraph={canViewGraph}
                canViewImports={canViewImports}
                canViewSearch={canViewSearch}
                organizations={organizations}
              />
              <HumansMark />
            </div>
            <div className="hidden min-w-0 lg:block">
              <p className="truncate text-sm font-semibold">
                {activeWorkspace.name}
              </p>
              <p className="text-muted-foreground text-xs">
                Verified workspace
              </p>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <CommandMenu
                canCreatePerson={canCreatePerson}
                canViewAnalyst={canViewAnalyst}
                canViewEvidence={canViewEvidence}
                canViewGraph={canViewGraph}
                canViewImports={canViewImports}
                canViewSearch={canViewSearch}
              />
              <ThemeToggle />
              <div className="lg:hidden">
                <SignOutControl />
              </div>
            </div>
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className="px-4 py-7 sm:px-6 lg:px-10 lg:py-10"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
