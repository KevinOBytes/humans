import type { WorkspaceRole } from "@/modules/auth/permissions";

export const invitibleWorkspaceRoles = [
  "admin",
  "analyst",
  "contributor",
  "viewer",
] as const satisfies readonly WorkspaceRole[];

const lowerRoles = new Set<WorkspaceRole>(["analyst", "contributor", "viewer"]);

export function canInviteRole(
  actorRole: WorkspaceRole,
  requestedRole: WorkspaceRole,
): boolean {
  if (requestedRole === "owner") return false;
  return (
    actorRole === "owner" ||
    (actorRole === "admin" && lowerRoles.has(requestedRole))
  );
}

export function canManageMember(input: {
  actorRole: WorkspaceRole;
  actorUserId: string;
  targetRole: WorkspaceRole;
  targetUserId: string;
  nextRole?: WorkspaceRole;
}): boolean {
  if (input.actorUserId === input.targetUserId) return false;
  if (input.actorRole === "owner") {
    return input.nextRole !== "owner";
  }
  if (input.actorRole !== "admin" || !lowerRoles.has(input.targetRole)) {
    return false;
  }
  return input.nextRole === undefined || lowerRoles.has(input.nextRole);
}
