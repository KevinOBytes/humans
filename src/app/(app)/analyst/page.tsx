import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { BrowserAnalyst } from "@/components/ai/analyst-browser-adapter";

export default async function AnalystPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const permissions = context.viewer.permissions;
  if (!permissions.includes("analysis:read")) notFound();
  return (
    <BrowserAnalyst
      canCancel={permissions.includes("analysis:cancel")}
      canStart={["analysis:create", "analysis:run"].every((permission) =>
        permissions.includes(permission),
      )}
      workspaceIdentity={context.viewer.workspace.id}
    />
  );
}
