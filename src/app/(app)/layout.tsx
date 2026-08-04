import type { ReactNode } from "react";

import { createWorkspace } from "@/app/(app)/workspace-actions";
import { AppShell } from "@/components/app-shell";
import { WorkspaceGate } from "@/components/workspace-gate";

import { getAppContext } from "./app-session";

export const dynamic = "force-dynamic";

export default async function ProtectedAppLayout({
  children,
}: {
  children: ReactNode;
}) {
  const context = await getAppContext();
  const organizations = context.organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
  }));
  if (!context.viewer) {
    return (
      <WorkspaceGate
        createWorkspace={createWorkspace}
        organizations={organizations}
      />
    );
  }
  const activeWorkspace = {
    id: context.viewer.workspace.organizationId,
    name: context.viewer.workspace.name,
  };
  return (
    <AppShell
      activeWorkspace={activeWorkspace}
      organizations={organizations}
      viewer={{
        displayName: context.session.user.name ?? context.session.user.email,
        email: context.session.user.email,
        permissions: context.viewer.permissions,
        role: context.viewer.role ?? "member",
      }}
    >
      {children}
    </AppShell>
  );
}
