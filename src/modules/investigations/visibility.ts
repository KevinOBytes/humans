/**
 * An investigation is not a workspace-wide directory for every reader.
 * Managers can administer the workspace, while other principals must have a
 * direct lead, case, or team relationship before its metadata is disclosed.
 * This is deliberately independent of the permission vocabulary: callers
 * still need `investigation:read` before evaluating this boundary.
 */
export function canViewInvestigation(input: {
  actorRole: string | null;
  actorType: "user" | "apiKey" | "worker";
  hasCaseMembership: boolean;
  hasTeamMembership: boolean;
  leadPrincipalId: string;
  principalId: string;
}): boolean {
  return (
    isWorkspaceManager(input) ||
    input.leadPrincipalId === input.principalId ||
    input.hasCaseMembership ||
    input.hasTeamMembership
  );
}

export function isWorkspaceManager(input: {
  actorRole: string | null;
  actorType: "user" | "apiKey" | "worker";
}): boolean {
  return (
    input.actorType === "user" &&
    (input.actorRole === "owner" || input.actorRole === "admin")
  );
}
