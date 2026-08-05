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
import { defaultKeyHasher } from "@better-auth/api-key";
import { generateRandomString } from "better-auth/crypto";

import { newId } from "@/db/id";
import { apiKeys, members } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import {
  accessPolicies,
  resourceGrants,
  retentionPolicies,
  workspaceSettings,
  workspaces,
} from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type PolicySettingsReadModel = {
  workspace: {
    version: number;
    name: string;
    locale: string;
    timezone: string;
    defaultRetentionDays: number | null;
    aiEnabled: boolean;
    retainRestrictedAiPrompts: boolean;
    storageEnabled: boolean;
  };
  accessPolicies: readonly {
    id: string;
    version: number;
    name: string;
    state: string;
    sensitivityCeiling: string;
    resourceKinds: readonly string[];
  }[];
  resourceGrants: readonly {
    id: string;
    policyId: string;
    resourceId: string;
    resourceKind: string;
    memberId: string | null;
    role: string | null;
    state: string;
    validFrom: Date | null;
    validUntil: Date | null;
    version: number;
  }[];
  retentionPolicies: readonly {
    resourceKind: string;
    retentionDays: number;
    deletionBehavior: string;
  }[];
};

export type WorkspacePolicySummaryReadModel = {
  defaultRetentionDays: number | null;
  aiEnabled: boolean;
  retainRestrictedAiPrompts: boolean;
  storageEnabled: boolean;
};

type TransactionDatabase = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

async function lockAndRevalidateAdministrativeActor(input: {
  actor: { id: string; memberId: string };
  lockRows?: boolean;
  transaction: TransactionDatabase;
  workspaceId: string;
}): Promise<"admin" | "owner" | null> {
  await input.transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 0))`,
  );
  const query = input.transaction
    .select({ id: members.id, role: members.role })
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
    .limit(2);
  const rows =
    input.lockRows === false ? await query : await query.for("update");
  const row = rows[0];
  return rows.length === 1 &&
    row &&
    (row.role === "owner" || row.role === "admin")
    ? row.role
    : null;
}

export function createSettingsRepository(database: Database) {
  return {
    /**
     * Inserts an organization API key in the caller's transaction in the
     * disabled state. Better Auth's public createApiKey endpoint always
     * inserts enabled rows through its own adapter call, which cannot share
     * the application transaction. Generating and hashing the credential
     * here keeps the insert, principal, activation, and audit in one commit.
     */
    async createOrganizationApiKeyInTransaction(input: {
      expiresInSeconds?: number;
      name: string;
      organizationId: string;
      permissions: Record<string, string[]>;
      transaction: TransactionDatabase;
      workspaceId: string;
    }) {
      const rawKey = `hum_${generateRandomString(64, "a-z", "A-Z")}`;
      const now = new Date();
      const expiresAt =
        input.expiresInSeconds === undefined
          ? null
          : new Date(now.getTime() + input.expiresInSeconds * 1_000);
      const [created] = await input.transaction
        .insert(apiKeys)
        .values({
          id: newId(),
          configId: "organization",
          name: input.name,
          prefix: "hum_",
          start: rawKey.slice(0, 6),
          referenceId: input.organizationId,
          key: await defaultKeyHasher(rawKey),
          enabled: false,
          rateLimitEnabled: true,
          rateLimitTimeWindow: 86_400_000,
          rateLimitMax: 10,
          requestCount: 0,
          remaining: null,
          refillAmount: null,
          refillInterval: null,
          lastRefillAt: null,
          lastRequest: null,
          expiresAt,
          createdAt: now,
          updatedAt: now,
          permissions: JSON.stringify(input.permissions),
          metadata: null,
          workspaceId: input.workspaceId,
        })
        .returning({
          id: apiKeys.id,
          createdAt: apiKeys.createdAt,
          updatedAt: apiKeys.updatedAt,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          start: apiKeys.start,
          enabled: apiKeys.enabled,
          expiresAt: apiKeys.expiresAt,
          referenceId: apiKeys.referenceId,
          lastRefillAt: apiKeys.lastRefillAt,
          lastRequest: apiKeys.lastRequest,
          metadata: apiKeys.metadata,
          rateLimitMax: apiKeys.rateLimitMax,
          rateLimitTimeWindow: apiKeys.rateLimitTimeWindow,
          remaining: apiKeys.remaining,
          refillAmount: apiKeys.refillAmount,
          refillInterval: apiKeys.refillInterval,
          rateLimitEnabled: apiKeys.rateLimitEnabled,
          requestCount: apiKeys.requestCount,
          permissions: apiKeys.permissions,
        });
      if (!created) throw new Error("Created API key could not be stored");
      return { ...created, key: rawKey };
    },
    async withAdministrativeApiKeyLifecycle<T>(input: {
      actor: { id: string; memberId: string };
      run: (
        transaction: TransactionDatabase,
        role: "admin" | "owner",
      ) => Promise<T>;
      workspaceId: string;
    }): Promise<{ status: "APPLIED"; value: T } | { status: "FORBIDDEN" }> {
      return database.transaction(async (transaction) => {
        const role = await lockAndRevalidateAdministrativeActor({
          actor: input.actor,
          lockRows: false,
          transaction,
          workspaceId: input.workspaceId,
        });
        if (!role) return { status: "FORBIDDEN" } as const;
        return {
          status: "APPLIED",
          value: await input.run(transaction, role),
        } as const;
      });
    },
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
    async disableCreatedOrganizationApiKey(input: {
      apiKeyId: string;
      workspaceId: string;
    }): Promise<void> {
      await database
        .update(apiKeys)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, input.apiKeyId),
            eq(apiKeys.workspaceId, input.workspaceId),
            eq(apiKeys.configId, "organization"),
          ),
        );
    },
    async activateCreatedOrganizationApiKey(input: {
      apiKeyId: string;
      transaction: TransactionDatabase;
      workspaceId: string;
    }): Promise<boolean> {
      const updated = await input.transaction
        .update(apiKeys)
        .set({ enabled: true, updatedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, input.apiKeyId),
            eq(apiKeys.workspaceId, input.workspaceId),
            eq(apiKeys.configId, "organization"),
            eq(apiKeys.enabled, false),
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
        const role = await lockAndRevalidateAdministrativeActor({
          actor: input.actor,
          transaction,
          workspaceId: input.workspaceId,
        });
        if (!role) return "FORBIDDEN";
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
      transaction?: TransactionDatabase;
      workspaceId: string;
    }): Promise<void> {
      await (input.transaction ?? database).insert(auditEvents).values({
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
          version: workspaceSettings.version,
          locale: workspaceSettings.locale,
          timezone: workspaceSettings.timezone,
          defaultRetentionDays: workspaceSettings.retentionDays,
          aiEnabled: workspaceSettings.aiEnabled,
          retainRestrictedAiPrompts:
            workspaceSettings.retainRestrictedAiPrompts,
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
            id: accessPolicies.id,
            version: accessPolicies.version,
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
      const grants = await database
        .select({
          id: resourceGrants.id,
          policyId: resourceGrants.policyId,
          resourceId: resourceGrants.resourceId,
          resourceKind: resourceGrants.resourceKind,
          memberId: resourceGrants.memberId,
          role: resourceGrants.role,
          state: resourceGrants.state,
          validFrom: resourceGrants.validFrom,
          validUntil: resourceGrants.validUntil,
          version: resourceGrants.version,
        })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.workspaceId, workspaceId),
            isNull(resourceGrants.deletedAt),
          ),
        );
      return {
        workspace,
        accessPolicies: policies,
        retentionPolicies: retention,
        resourceGrants: grants,
      };
    },
    async readWorkspacePolicySummary(
      workspaceId: string,
    ): Promise<WorkspacePolicySummaryReadModel | null> {
      const rows = await database
        .select({
          defaultRetentionDays: workspaceSettings.retentionDays,
          aiEnabled: workspaceSettings.aiEnabled,
          retainRestrictedAiPrompts:
            workspaceSettings.retainRestrictedAiPrompts,
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
      return rows.length === 1 ? (rows[0] ?? null) : null;
    },
  };
}
