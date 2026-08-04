import "server-only";

import type { BetterAuthRuntime } from "@/lib/auth/config";
import {
  canViewWorkspaceAdministration,
  mapSafeInvitation,
  mapSafeMember,
  type SafeInvitationSettings,
  type SafeMemberSettings,
} from "@/modules/settings/read-model";
import {
  SETTINGS_PAGE_SIZE,
  buildSafeSettingsPage,
  normalizeSettingsOffset,
  type SafeSettingsPage,
} from "@/modules/settings/pagination";

export class SettingsAccessError extends Error {
  constructor() {
    super(
      "Workspace settings are available only to owners and administrators.",
    );
    this.name = "SettingsAccessError";
  }
}

async function requireAdministrativeSession(
  auth: BetterAuthRuntime,
  requestHeaders: Headers,
): Promise<string> {
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  const organizationId = session?.session.activeOrganizationId;
  if (!session || !organizationId) throw new SettingsAccessError();

  const membership = await auth.api.getActiveMemberRole({
    headers: requestHeaders,
    query: { organizationId },
  });
  if (!canViewWorkspaceAdministration(membership.role)) {
    throw new SettingsAccessError();
  }
  return organizationId;
}

export async function listSafeWorkspaceDirectory(input: {
  auth: BetterAuthRuntime;
  headers: Headers;
  memberOffset?: number;
  now?: Date;
}): Promise<{
  members: SafeSettingsPage<SafeMemberSettings>;
  invitations: readonly SafeInvitationSettings[];
}> {
  const organizationId = await requireAdministrativeSession(
    input.auth,
    input.headers,
  );
  const memberOffset = normalizeSettingsOffset(input.memberOffset);
  const [memberResult, invitations] = await Promise.all([
    input.auth.api.listMembers({
      headers: input.headers,
      query: {
        organizationId,
        limit: SETTINGS_PAGE_SIZE,
        offset: memberOffset,
        sortBy: "id",
        sortDirection: "asc",
      },
    }),
    input.auth.api.listInvitations({
      headers: input.headers,
      query: { organizationId },
    }),
  ]);
  const safeInvitations = invitations.map((invitation) =>
    mapSafeInvitation(invitation, input.now),
  );
  return {
    members: buildSafeSettingsPage(
      memberResult.members.map(mapSafeMember),
      memberOffset,
      memberResult.total,
    ),
    invitations: safeInvitations.filter(
      (invitation) =>
        invitation.status === "pending" || invitation.status === "expired",
    ),
  };
}
