import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { newId } from "@/db/id";
import { apiKeys, members } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
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

type TransactionDatabase = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

async function lockAndRevalidateAdministrativeActor(input: {
  actor: { id: string; memberId: string };
  transaction: TransactionDatabase;
  workspaceId: string;
}): Promise<boolean> {
  await input.transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 0))`,
  );
  const rows = await input.transaction
    .select({ id: members.id })
    .from(workspaces)
    .innerJoin(
      members,
      and(
        eq(members.workspaceId, workspaces.id),
        eq(members.organizationId, workspaces.organizationId),
      ),
    )
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
        eq(members.id, input.actor.memberId),
        eq(members.userId, input.actor.id),
        inArray(members.role, ["owner", "admin"]),
      ),
    )
    .limit(2)
    .for("update");
  return rows.length === 1;
}

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
    async readAdministrativeMembership(input: {
      memberId: string;
      userId: string;
      workspaceId: string;
    }): Promise<{ role: "admin" | "owner" } | null> {
      const active = await database
        .select({ role: members.role })
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
      const row = active[0];
      return active.length === 1 &&
        (row?.role === "owner" || row?.role === "admin")
        ? { role: row.role }
        : null;
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
            id: apiKeys.id,
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
    async findOrganizationApiKeyCandidates(workspaceId: string) {
      return database
        .select({
          id: apiKeys.id,
          enabled: apiKeys.enabled,
          expiresAt: apiKeys.expiresAt,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.workspaceId, workspaceId),
            eq(apiKeys.configId, "organization"),
          ),
        );
    },
    async disableOrganizationApiKey(input: {
      apiKeyId: string;
      workspaceId: string;
    }): Promise<boolean> {
      const updated = await database
        .update(apiKeys)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, input.apiKeyId),
            eq(apiKeys.workspaceId, input.workspaceId),
            eq(apiKeys.configId, "organization"),
            eq(apiKeys.enabled, true),
          ),
        )
        .returning({ id: apiKeys.id });
      return updated.length === 1;
    },
    async disableOrganizationApiKeyWithAudit(input: {
      action: "settings.api_key.revoke" | "settings.api_key.rotate";
      apiKeyId: string;
      actor: { id: string; memberId: string; sessionId: string };
      changedFields: readonly string[];
      requestId: string;
      workspaceId: string;
    }): Promise<"APPLIED" | "FORBIDDEN" | "INVALID"> {
      return database.transaction(async (transaction) => {
        const authorized = await lockAndRevalidateAdministrativeActor({
          actor: input.actor,
          transaction,
          workspaceId: input.workspaceId,
        });
        if (!authorized) return "FORBIDDEN";
        const updated = await transaction
          .update(apiKeys)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(
              eq(apiKeys.id, input.apiKeyId),
              eq(apiKeys.workspaceId, input.workspaceId),
              eq(apiKeys.configId, "organization"),
              eq(apiKeys.enabled, true),
              or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
            ),
          )
          .returning({ id: apiKeys.id });
        if (updated.length !== 1) return "INVALID";
        await transaction.insert(auditEvents).values({
          id: newId(),
          workspaceId: input.workspaceId,
          actorUserId: input.actor.id,
          sessionId: input.actor.sessionId,
          action: input.action,
          resourceKind: "api_key",
          resourceId: null,
          requestId: input.requestId,
          redactedDiff: { changedFields: [...input.changedFields] },
          outcome: "success",
        });
        return "APPLIED";
      });
    },
    async recordApiKeyLifecycleAudit(input: {
      action: "settings.api_key.create";
      actor: { id: string; sessionId: string };
      changedFields: readonly string[];
      requestId: string;
      workspaceId: string;
    }): Promise<void> {
      await database.insert(auditEvents).values({
        id: newId(),
        workspaceId: input.workspaceId,
        actorUserId: input.actor.id,
        sessionId: input.actor.sessionId,
        action: input.action,
        resourceKind: "api_key",
        resourceId: null,
        requestId: input.requestId,
        redactedDiff: { changedFields: [...input.changedFields] },
        outcome: "success",
      });
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
