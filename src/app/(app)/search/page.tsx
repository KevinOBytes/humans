import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { BrowserSearchWorkbench } from "@/components/search/search-browser-adapter";

export default async function SearchPage() {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const permissions = context.viewer.permissions;
  if (!permissions.includes("search:read")) notFound();
  return (
    <BrowserSearchWorkbench
      canManageSaved={[
        "savedQuery:read",
        "savedQuery:create",
        "savedQuery:update",
        "savedQuery:delete",
        "savedQuery:run",
        "search:run",
      ].every((permission) => permissions.includes(permission))}
      viewerPrincipalId={context.viewer.principalId}
      workspaceIdentity={context.viewer.workspace.id}
    />
  );
}
