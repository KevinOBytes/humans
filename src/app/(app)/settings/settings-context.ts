import "server-only";

import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { canViewWorkspaceAdministration } from "@/modules/settings/read-model";

export async function getAdministrativeSettingsContext() {
  const context = await getAppContext();
  if (
    !context.viewer ||
    context.viewer.actorType !== "USER" ||
    !canViewWorkspaceAdministration(context.viewer.role)
  ) {
    notFound();
  }
  return context;
}
