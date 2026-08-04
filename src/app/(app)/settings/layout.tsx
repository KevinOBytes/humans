import type { ReactNode } from "react";

import { getAppContext } from "@/app/(app)/app-session";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { canViewWorkspaceAdministration } from "@/modules/settings/read-model";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const context = await getAppContext();
  return (
    <div className="space-y-7">
      <SettingsNavigation
        canAdministerWorkspace={canViewWorkspaceAdministration(
          context.viewer?.role,
        )}
      />
      {children}
    </div>
  );
}
