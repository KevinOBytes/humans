import type { GraphQLActor } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  SETTINGS_PAGE_SIZE,
  buildSafeSettingsPage,
  normalizeSettingsOffset,
} from "@/modules/settings/pagination";
import { mapSafeApiKey } from "@/modules/settings/read-model";
import {
  createWorkspaceMemberAdministration,
  type WorkspaceMemberRuntime,
} from "@/modules/settings/workspace-members";

import { createSettingsRepository } from "./repository";

export function createSettingsService(input: {
  actor: GraphQLActor;
  database: Database;
  requestId?: string;
  runtime?: WorkspaceMemberRuntime;
  workspaceId: string;
}) {
  const repository = createSettingsRepository(input.database);
  const members = createWorkspaceMemberAdministration({
    ...input,
    requestId: input.requestId ?? crypto.randomUUID(),
  });

  async function authorizeAdministrator() {
    if (input.actor.type !== "user") {
      throw createGraphQLError(
        "FORBIDDEN",
        "Workspace settings require an administrator session.",
      );
    }
    const active = await repository.hasAdministrativeMembership({
      memberId: input.actor.memberId,
      userId: input.actor.id,
      workspaceId: input.workspaceId,
    });
    if (!active) {
      throw createGraphQLError(
        "FORBIDDEN",
        "Workspace settings require an administrator session.",
      );
    }
  }

  return {
    directory: members.directory,
    issueInvitation: members.issueInvitation,
    resendInvitation: members.resendInvitation,
    cancelInvitation: members.cancelInvitation,
    updateMemberRole: members.updateMemberRole,
    removeMember: members.removeMember,
    async listOrganizationApiKeys(requestedOffset?: number | null) {
      await authorizeAdministrator();
      const offset = normalizeSettingsOffset(requestedOffset);
      const result = await repository.listOrganizationApiKeys({
        workspaceId: input.workspaceId,
        limit: SETTINGS_PAGE_SIZE,
        offset,
      });
      const nodes = result.rows.map((row) =>
        mapSafeApiKey({
          ...row,
          permissions: parsePermissions(row.permissions),
        }),
      );
      return buildSafeSettingsPage(nodes, offset, result.total);
    },
    async readPolicySettings() {
      await authorizeAdministrator();
      const settings = await repository.readPolicySettings(input.workspaceId);
      if (!settings) {
        throw createGraphQLError(
          "NOT_FOUND",
          "Workspace settings are unavailable.",
        );
      }
      return settings;
    },
  };
}

function parsePermissions(
  value: string | null,
): Record<string, readonly string[]> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) &&
          entry[1].every((action) => typeof action === "string"),
      ),
    );
  } catch {
    return null;
  }
}

export type SettingsService = ReturnType<typeof createSettingsService>;
