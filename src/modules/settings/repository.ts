import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";

import { apiKeys, members } from "@/db/schema/auth";
import {
  accessPolicies,
  retentionPolicies,
  workspaceSettings,
  workspaces,
} from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type PolicySettingsReadModel = {
  workspace: {
    name: string;
    locale: string;
    timezone: string;
    defaultRetentionDays: number | null;
    aiEnabled: boolean;
    storageEnabled: boolean;
  };
  accessPolicies: readonly {
    name: string;
    state: string;
    sensitivityCeiling: string;
    resourceKinds: readonly string[];
  }[];
  retentionPolicies: readonly {
    resourceKind: string;
    retentionDays: number;
    deletionBehavior: string;
  }[];
};

export function createSettingsRepository(database: Database) {
  return {
    async hasAdministrativeMembership(input: {
      memberId: string;
      userId: string;
      workspaceId: string;
    }): Promise<boolean> {
      const active = await database
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.id, input.memberId),
            eq(members.userId, input.userId),
            eq(members.workspaceId, input.workspaceId),
            inArray(members.role, ["owner", "admin"]),
          ),
        )
        .limit(2);
      return active.length === 1;
    },
    async listOrganizationApiKeys(input: {
      workspaceId: string;
      limit: number;
      offset: number;
    }) {
      const where = and(
        eq(apiKeys.workspaceId, input.workspaceId),
        eq(apiKeys.configId, "organization"),
      );
      const [rows, totals] = await Promise.all([
        database
          .select({
            name: apiKeys.name,
            prefix: apiKeys.prefix,
            start: apiKeys.start,
            enabled: apiKeys.enabled,
            permissions: apiKeys.permissions,
            createdAt: apiKeys.createdAt,
            updatedAt: apiKeys.updatedAt,
            expiresAt: apiKeys.expiresAt,
            lastRequest: apiKeys.lastRequest,
          })
          .from(apiKeys)
          .where(where)
          .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
          .limit(input.limit)
          .offset(input.offset),
        database.select({ value: count() }).from(apiKeys).where(where),
      ]);
      return { rows, total: totals[0]?.value ?? 0 };
    },
    async readPolicySettings(
      workspaceId: string,
    ): Promise<PolicySettingsReadModel | null> {
      const defaults = await database
        .select({
          name: workspaces.name,
          locale: workspaceSettings.locale,
          timezone: workspaceSettings.timezone,
          defaultRetentionDays: workspaceSettings.retentionDays,
          aiEnabled: workspaceSettings.aiEnabled,
          storageEnabled: workspaceSettings.storageEnabled,
        })
        .from(workspaces)
        .innerJoin(
          workspaceSettings,
          eq(workspaceSettings.workspaceId, workspaces.id),
        )
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.state, "active"),
            isNull(workspaces.deletedAt),
          ),
        )
        .limit(2);
      const workspace = defaults[0];
      if (defaults.length !== 1 || !workspace) return null;

      const [policies, retention] = await Promise.all([
        database
          .select({
            name: accessPolicies.name,
            state: accessPolicies.state,
            sensitivityCeiling: accessPolicies.sensitivityCeiling,
            resourceKinds: accessPolicies.resourceKinds,
          })
          .from(accessPolicies)
          .where(
            and(
              eq(accessPolicies.workspaceId, workspaceId),
              isNull(accessPolicies.deletedAt),
            ),
          ),
        database
          .select({
            resourceKind: retentionPolicies.resourceKind,
            retentionDays: retentionPolicies.retentionDays,
            deletionBehavior: retentionPolicies.deletionBehavior,
          })
          .from(retentionPolicies)
          .where(
            and(
              eq(retentionPolicies.workspaceId, workspaceId),
              isNull(retentionPolicies.deletedAt),
            ),
          ),
      ]);
      return {
        workspace,
        accessPolicies: policies,
        retentionPolicies: retention,
      };
    },
  };
}
