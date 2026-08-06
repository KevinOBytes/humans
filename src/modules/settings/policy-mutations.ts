import { createHmac } from "node:crypto";

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { members } from "@/db/schema/auth";
import {
  accessPolicies,
  legalHolds,
  resourceGrants,
  retentionPolicies,
  workspaceSettings,
} from "@/db/schema/workspaces";
import { consentRecords, deletionRequests } from "@/db/schema/privacy";
import { auditEvents, idempotencyKeys } from "@/db/schema/operations";
import { newId } from "@/db/id";
import type { GraphQLActor } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import type { Database } from "@/modules/auth/bootstrap-admin";

type TransactionDatabase = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

const RESOURCE_KIND = /^[a-z][a-z0-9_.-]{1,63}$/u;
const ROLE = /^(owner|admin|analyst|contributor|viewer)$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_MAX_BYTES = 128;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

function normalizePolicyName(value: string): string {
  const name = value.normalize("NFKC").trim();
  if (
    name.length < 1 ||
    name.length > 120 ||
    Buffer.byteLength(name, "utf8") > 512
  ) {
    throw createGraphQLError("VALIDATION_FAILED", "Policy name is invalid.");
  }
  return name;
}

export type PolicyMutationResult = {
  id: string | null;
  version: number | null;
  code: "APPLIED" | "CONFLICT" | "INVALID";
  requestId: string;
};

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function canonicalMaterial(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Invalid idempotency material");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalMaterial(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalMaterial(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Invalid idempotency material");
}

function parseStoredPolicyResult(value: unknown): PolicyMutationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(",") !== "code,id,requestId,version") return null;
  const validId =
    row.id === null || (typeof row.id === "string" && UUID.test(row.id));
  const validVersion =
    row.version === null ||
    (typeof row.version === "number" && Number.isSafeInteger(row.version));
  return validId &&
    validVersion &&
    (row.code === "APPLIED" ||
      row.code === "CONFLICT" ||
      row.code === "INVALID") &&
    typeof row.requestId === "string" &&
    row.requestId.length > 0
    ? (row as PolicyMutationResult)
    : null;
}

function requireUserAdmin(
  actor: GraphQLActor,
): Extract<GraphQLActor, { type: "user" }> {
  if (
    actor.type !== "user" ||
    (actor.role !== "owner" && actor.role !== "admin")
  ) {
    throw createGraphQLError(
      "FORBIDDEN",
      "Workspace policy administration requires an owner or admin.",
    );
  }
  return actor;
}

function validateResourceKinds(values: readonly string[]): string[] {
  const result = [
    ...new Set(values.map((value) => value.trim().toLowerCase())),
  ].sort();
  if (
    result.length < 1 ||
    result.length > 64 ||
    result.some((value) => !RESOURCE_KIND.test(value))
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Resource kinds are invalid.",
    );
  }
  return result;
}

function validateRoleBindings(
  value: unknown,
): Record<string, readonly string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Role bindings must be an object.",
    );
  }
  const result: Record<string, readonly string[]> = {};
  for (const [role, permissions] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !ROLE.test(role) ||
      !Array.isArray(permissions) ||
      permissions.length > 64 ||
      permissions.some((item) => typeof item !== "string" || item.length > 80)
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "Role bindings are invalid.",
      );
    }
    result[role] = [...new Set(permissions)];
  }
  return result;
}

async function audit(
  transaction: TransactionDatabase,
  input: {
    actor: Extract<GraphQLActor, { type: "user" }>;
    action: string;
    requestId: string;
    resourceId: string | null;
    resourceKind: string;
    workspaceId: string;
    outcome?: string;
  },
): Promise<void> {
  await transaction.insert(auditEvents).values({
    id: newId(),
    workspaceId: input.workspaceId,
    actorUserId: input.actor.id,
    sessionId: input.actor.sessionId,
    action: input.action,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    requestId: input.requestId,
    outcome: input.outcome ?? "success",
    redactedDiff: null,
  });
}

export function createPolicyMutationService(input: {
  actor: GraphQLActor;
  database: Database;
  idempotencySecret?: string;
  requestId: string;
  workspaceId: string;
}) {
  async function authorize(transaction: TransactionDatabase) {
    const actor = requireUserAdmin(input.actor);
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 0))`,
    );
    const rows = await transaction
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, input.workspaceId),
          eq(members.userId, actor.id),
          inArray(members.role, ["owner", "admin"]),
        ),
      )
      .limit(2)
      .for("update");
    if (rows.length !== 1) {
      throw createGraphQLError(
        "FORBIDDEN",
        "Workspace policy administration requires an owner or admin.",
      );
    }
    return actor;
  }

  async function mutation(
    operation: (
      transaction: TransactionDatabase,
      actor: Extract<GraphQLActor, { type: "user" }>,
    ) => Promise<PolicyMutationResult>,
  ): Promise<PolicyMutationResult> {
    return input.database.transaction(async (transaction) =>
      operation(transaction, await authorize(transaction)),
    );
  }

  async function idempotentMutation(options: {
    actor: Extract<GraphQLActor, { type: "user" }>;
    key: string | null | undefined;
    material: Record<string, unknown>;
    operation: string;
    run: () => Promise<PolicyMutationResult>;
    transaction: TransactionDatabase;
  }): Promise<PolicyMutationResult> {
    if (options.key === undefined || options.key === null) {
      return options.run();
    }
    const normalizedKey =
      typeof options.key === "string"
        ? options.key.normalize("NFKC").trim()
        : "";
    if (
      !input.idempotencySecret ||
      normalizedKey.length === 0 ||
      Buffer.byteLength(normalizedKey, "utf8") > IDEMPOTENCY_KEY_MAX_BYTES
    ) {
      return {
        id: null,
        version: null,
        code: "INVALID",
        requestId: input.requestId,
      };
    }
    const binding = `${input.workspaceId}:${options.actor.id}:${options.operation}`;
    const keyHash = hmac(
      input.idempotencySecret,
      `${binding}:key:${normalizedKey}`,
    );
    const requestHash = `sha256:${hmac(
      input.idempotencySecret,
      `${binding}:request:${canonicalMaterial(options.material)}`,
    )}`;
    const now = new Date();
    const identity = and(
      eq(idempotencyKeys.workspaceId, input.workspaceId),
      eq(idempotencyKeys.actorId, options.actor.id),
      eq(idempotencyKeys.operation, options.operation),
      eq(idempotencyKeys.keyHash, keyHash),
    );
    const [prior] = await options.transaction
      .select()
      .from(idempotencyKeys)
      .where(identity)
      .for("update");
    if (prior && prior.expiresAt <= now) {
      await options.transaction
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.workspaceId, input.workspaceId),
            eq(idempotencyKeys.id, prior.id),
            lte(idempotencyKeys.expiresAt, now),
          ),
        );
    } else if (prior) {
      if (prior.requestHash !== requestHash) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotency key is already bound to another request.",
        );
      }
      if (prior.status !== "completed" || prior.responseReference == null) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation is not replayable.",
        );
      }
      const stored = parseStoredPolicyResult(prior.responseReference);
      if (!stored) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      return stored;
    }

    const [inserted] = await options.transaction
      .insert(idempotencyKeys)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        actorId: options.actor.id,
        operation: options.operation,
        keyHash,
        requestHash,
        status: "pending",
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          idempotencyKeys.workspaceId,
          idempotencyKeys.actorId,
          idempotencyKeys.operation,
          idempotencyKeys.keyHash,
        ],
      })
      .returning({ id: idempotencyKeys.id });
    const [claim] = await options.transaction
      .select()
      .from(idempotencyKeys)
      .where(identity)
      .for("update");
    if (!claim) {
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation could not be claimed.",
      );
    }
    if (!inserted) {
      if (claim.expiresAt <= now) {
        throw createGraphQLError(
          "CONFLICT",
          "The expired idempotent operation could not be reclaimed.",
        );
      }
      if (claim.requestHash !== requestHash) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotency key is already bound to another request.",
        );
      }
      if (claim.status !== "completed" || claim.responseReference == null) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation is not replayable.",
        );
      }
      const stored = parseStoredPolicyResult(claim.responseReference);
      if (!stored) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      return stored;
    }
    const result = await options.run();
    const [completed] = await options.transaction
      .update(idempotencyKeys)
      .set({
        status: "completed",
        responseReference: result,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(idempotencyKeys.workspaceId, input.workspaceId),
          eq(idempotencyKeys.id, claim.id),
          eq(idempotencyKeys.status, "pending"),
        ),
      )
      .returning({ id: idempotencyKeys.id });
    if (!completed) {
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation could not be completed.",
      );
    }
    return result;
  }

  return {
    updateWorkspaceDefaults(inputValue: {
      expectedVersion: number;
      idempotencyKey?: string | null;
      locale?: string | null;
      timezone?: string | null;
      retentionDays?: number | null;
      aiEnabled?: boolean | null;
      retainRestrictedAiPrompts?: boolean | null;
      storageEnabled?: boolean | null;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        return idempotentMutation({
          actor,
          key: inputValue.idempotencyKey,
          material: {
            aiEnabled: inputValue.aiEnabled,
            expectedVersion: inputValue.expectedVersion,
            locale: inputValue.locale,
            retainRestrictedAiPrompts: inputValue.retainRestrictedAiPrompts,
            retentionDays: inputValue.retentionDays,
            storageEnabled: inputValue.storageEnabled,
            timezone: inputValue.timezone,
          },
          operation: "workspace.defaults.update",
          transaction,
          run: async () => {
            const patch = {
              ...(inputValue.locale == null
                ? {}
                : { locale: inputValue.locale.trim().slice(0, 64) }),
              ...(inputValue.timezone == null
                ? {}
                : { timezone: inputValue.timezone.trim().slice(0, 64) }),
              ...(inputValue.retentionDays === undefined
                ? {}
                : { retentionDays: inputValue.retentionDays }),
              ...(inputValue.aiEnabled == null
                ? {}
                : { aiEnabled: inputValue.aiEnabled }),
              ...(inputValue.retainRestrictedAiPrompts == null
                ? {}
                : {
                    retainRestrictedAiPrompts:
                      inputValue.retainRestrictedAiPrompts,
                  }),
              ...(inputValue.storageEnabled == null
                ? {}
                : { storageEnabled: inputValue.storageEnabled }),
              version: sql`${workspaceSettings.version} + 1`,
              updatedAt: new Date(),
              updatedBy: actor.id,
            };
            const updated = await transaction
              .update(workspaceSettings)
              .set(patch)
              .where(
                and(
                  eq(workspaceSettings.workspaceId, input.workspaceId),
                  eq(workspaceSettings.version, inputValue.expectedVersion),
                ),
              )
              .returning({
                id: workspaceSettings.id,
                version: workspaceSettings.version,
              });
            const row = updated[0];
            if (!row)
              return {
                id: null,
                version: null,
                code: "CONFLICT",
                requestId: input.requestId,
              };
            await audit(transaction, {
              actor,
              action: "workspace.policy.update",
              requestId: input.requestId,
              resourceId: row.id,
              resourceKind: "workspace_settings",
              workspaceId: input.workspaceId,
            });
            return {
              id: row.id,
              version: row.version,
              code: "APPLIED",
              requestId: input.requestId,
            };
          },
        });
      });
    },
    createAccessPolicy(inputValue: {
      idempotencyKey?: string | null;
      name: string;
      sensitivityCeiling: "public" | "internal" | "confidential" | "restricted";
      resourceKinds: readonly string[];
      roleBindings: unknown;
      state: "draft" | "active" | "disabled" | "archived";
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        const normalizedName = normalizePolicyName(inputValue.name);
        const normalizedResourceKinds = validateResourceKinds(
          inputValue.resourceKinds,
        );
        const normalizedRoleBindings = validateRoleBindings(
          inputValue.roleBindings,
        );
        return idempotentMutation({
          actor,
          key: inputValue.idempotencyKey,
          material: {
            name: normalizedName,
            resourceKinds: normalizedResourceKinds,
            roleBindings: normalizedRoleBindings,
            sensitivityCeiling: inputValue.sensitivityCeiling,
            state: inputValue.state,
          },
          operation: "access_policy.create",
          transaction,
          run: async () => {
            const id = newId();
            await transaction.insert(accessPolicies).values({
              id,
              workspaceId: input.workspaceId,
              name: normalizedName,
              sensitivityCeiling: inputValue.sensitivityCeiling,
              resourceKinds: normalizedResourceKinds,
              roleBindings: normalizedRoleBindings,
              state: inputValue.state,
              createdBy: actor.id,
              updatedBy: actor.id,
            });
            await audit(transaction, {
              actor,
              action: "access_policy.create",
              requestId: input.requestId,
              resourceId: id,
              resourceKind: "access_policy",
              workspaceId: input.workspaceId,
            });
            return {
              id,
              version: 1,
              code: "APPLIED",
              requestId: input.requestId,
            };
          },
        });
      });
    },
    updateAccessPolicy(inputValue: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      name?: string | null;
      sensitivityCeiling?:
        "public" | "internal" | "confidential" | "restricted" | null;
      resourceKinds?: readonly string[] | null;
      roleBindings?: unknown;
      state?: "draft" | "active" | "disabled" | "archived" | null;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        return idempotentMutation({
          actor,
          key: inputValue.idempotencyKey,
          material: {
            expectedVersion: inputValue.expectedVersion,
            id: inputValue.id,
            name: inputValue.name,
            resourceKinds: inputValue.resourceKinds,
            roleBindings: inputValue.roleBindings,
            sensitivityCeiling: inputValue.sensitivityCeiling,
            state: inputValue.state,
          },
          operation: "access_policy.update",
          transaction,
          run: async () => {
            const updated = await transaction
              .update(accessPolicies)
              .set({
                ...(inputValue.name == null
                  ? {}
                  : {
                      name: normalizePolicyName(inputValue.name),
                    }),
                ...(inputValue.sensitivityCeiling == null
                  ? {}
                  : { sensitivityCeiling: inputValue.sensitivityCeiling }),
                ...(inputValue.resourceKinds == null
                  ? {}
                  : {
                      resourceKinds: validateResourceKinds(
                        inputValue.resourceKinds,
                      ),
                    }),
                ...(inputValue.roleBindings === undefined
                  ? {}
                  : {
                      roleBindings: validateRoleBindings(
                        inputValue.roleBindings,
                      ),
                    }),
                ...(inputValue.state == null
                  ? {}
                  : { state: inputValue.state }),
                version: sql`${accessPolicies.version} + 1`,
                updatedAt: new Date(),
                updatedBy: actor.id,
              })
              .where(
                and(
                  eq(accessPolicies.id, inputValue.id),
                  eq(accessPolicies.workspaceId, input.workspaceId),
                  eq(accessPolicies.version, inputValue.expectedVersion),
                  isNull(accessPolicies.deletedAt),
                ),
              )
              .returning({
                id: accessPolicies.id,
                version: accessPolicies.version,
              });
            const row = updated[0];
            if (!row)
              return {
                id: null,
                version: null,
                code: "CONFLICT",
                requestId: input.requestId,
              };
            await audit(transaction, {
              actor,
              action: "access_policy.update",
              requestId: input.requestId,
              resourceId: row.id,
              resourceKind: "access_policy",
              workspaceId: input.workspaceId,
            });
            return {
              id: row.id,
              version: row.version,
              code: "APPLIED",
              requestId: input.requestId,
            };
          },
        });
      });
    },
    archiveAccessPolicy(
      id: string,
      expectedVersion: number,
      idempotencyKey?: string | null,
    ): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        return idempotentMutation({
          actor,
          key: idempotencyKey,
          material: { expectedVersion, id },
          operation: "access_policy.archive",
          transaction,
          run: async () => {
            const updated = await transaction
              .update(accessPolicies)
              .set({
                state: "archived",
                deletedAt: new Date(),
                deletedBy: actor.id,
                updatedAt: new Date(),
                updatedBy: actor.id,
                version: sql`${accessPolicies.version} + 1`,
              })
              .where(
                and(
                  eq(accessPolicies.id, id),
                  eq(accessPolicies.workspaceId, input.workspaceId),
                  eq(accessPolicies.version, expectedVersion),
                  isNull(accessPolicies.deletedAt),
                ),
              )
              .returning({
                id: accessPolicies.id,
                version: accessPolicies.version,
              });
            const row = updated[0];
            if (!row)
              return {
                id: null,
                version: null,
                code: "CONFLICT",
                requestId: input.requestId,
              };
            await audit(transaction, {
              actor,
              action: "access_policy.archive",
              requestId: input.requestId,
              resourceId: row.id,
              resourceKind: "access_policy",
              workspaceId: input.workspaceId,
            });
            return {
              id: row.id,
              version: row.version,
              code: "APPLIED",
              requestId: input.requestId,
            };
          },
        });
      });
    },
    createResourceGrant(inputValue: {
      idempotencyKey?: string | null;
      policyId: string;
      resourceId: string;
      resourceKind: string;
      memberId?: string | null;
      role?: string | null;
      validFrom?: Date | null;
      validUntil?: Date | null;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        return idempotentMutation({
          actor,
          key: inputValue.idempotencyKey,
          material: {
            policyId: inputValue.policyId,
            resourceId: inputValue.resourceId,
            resourceKind: inputValue.resourceKind.trim().toLowerCase(),
            memberId: inputValue.memberId,
            role: inputValue.role?.trim().toLowerCase() ?? null,
            validFrom: inputValue.validFrom?.toISOString() ?? null,
            validUntil: inputValue.validUntil?.toISOString() ?? null,
          },
          operation: "resource_grant.create",
          transaction,
          run: async () => {
            const resourceKind = inputValue.resourceKind.trim().toLowerCase();
            const hasMember = Boolean(inputValue.memberId);
            const hasRole = Boolean(inputValue.role);
            if (
              !RESOURCE_KIND.test(resourceKind) ||
              !UUID.test(inputValue.resourceId) ||
              !UUID.test(inputValue.policyId) ||
              hasMember === hasRole ||
              (hasRole && !ROLE.test(inputValue.role ?? "")) ||
              (inputValue.validFrom &&
                inputValue.validUntil &&
                inputValue.validUntil < inputValue.validFrom)
            ) {
              throw createGraphQLError(
                "VALIDATION_FAILED",
                "Resource grant is invalid.",
              );
            }
            const [policy] = await transaction
              .select({ id: accessPolicies.id })
              .from(accessPolicies)
              .where(
                and(
                  eq(accessPolicies.id, inputValue.policyId),
                  eq(accessPolicies.workspaceId, input.workspaceId),
                  eq(accessPolicies.state, "active"),
                  isNull(accessPolicies.deletedAt),
                ),
              )
              .limit(1)
              .for("share");
            if (!policy)
              throw createGraphQLError("NOT_FOUND", "Access policy not found.");
            if (inputValue.memberId) {
              const [member] = await transaction
                .select({ id: members.id })
                .from(members)
                .where(
                  and(
                    eq(members.id, inputValue.memberId),
                    eq(members.workspaceId, input.workspaceId),
                  ),
                )
                .limit(1)
                .for("share");
              if (!member)
                throw createGraphQLError(
                  "NOT_FOUND",
                  "Grant member not found.",
                );
            }
            const id = newId();
            await transaction.insert(resourceGrants).values({
              id,
              workspaceId: input.workspaceId,
              policyId: inputValue.policyId,
              memberId: inputValue.memberId ?? null,
              role: inputValue.role?.toLowerCase() ?? null,
              resourceId: inputValue.resourceId,
              resourceKind,
              validFrom: inputValue.validFrom ?? null,
              validUntil: inputValue.validUntil ?? null,
              createdBy: actor.id,
              updatedBy: actor.id,
            });
            await audit(transaction, {
              actor,
              action: "resource_grant.create",
              requestId: input.requestId,
              resourceId: id,
              resourceKind: "resource_grant",
              workspaceId: input.workspaceId,
            });
            return {
              id,
              version: 1,
              code: "APPLIED",
              requestId: input.requestId,
            };
          },
        });
      });
    },
    updateResourceGrant(inputValue: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      validFrom?: Date | null;
      validUntil?: Date | null;
      state?: "active" | "inactive" | "archived";
      operation?: "resource_grant.update" | "resource_grant.archive";
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        return idempotentMutation({
          actor,
          key: inputValue.idempotencyKey,
          material: {
            expectedVersion: inputValue.expectedVersion,
            id: inputValue.id,
            state: inputValue.state,
            validFrom: inputValue.validFrom?.toISOString() ?? null,
            validUntil: inputValue.validUntil?.toISOString() ?? null,
          },
          operation: inputValue.operation ?? "resource_grant.update",
          transaction,
          run: async () => {
            if (
              inputValue.validFrom &&
              inputValue.validUntil &&
              inputValue.validUntil < inputValue.validFrom
            ) {
              throw createGraphQLError(
                "VALIDATION_FAILED",
                "Resource grant validity is invalid.",
              );
            }
            const [updated] = await transaction
              .update(resourceGrants)
              .set({
                ...(inputValue.validFrom === undefined
                  ? {}
                  : { validFrom: inputValue.validFrom }),
                ...(inputValue.validUntil === undefined
                  ? {}
                  : { validUntil: inputValue.validUntil }),
                ...(inputValue.state === undefined
                  ? {}
                  : { state: inputValue.state }),
                version: sql`${resourceGrants.version} + 1`,
                updatedAt: new Date(),
                updatedBy: actor.id,
                ...(inputValue.state === "archived"
                  ? { deletedAt: new Date(), deletedBy: actor.id }
                  : {}),
              })
              .where(
                and(
                  eq(resourceGrants.id, inputValue.id),
                  eq(resourceGrants.workspaceId, input.workspaceId),
                  eq(resourceGrants.version, inputValue.expectedVersion),
                  isNull(resourceGrants.deletedAt),
                ),
              )
              .returning({
                id: resourceGrants.id,
                version: resourceGrants.version,
              });
            if (!updated)
              return {
                id: null,
                version: null,
                code: "CONFLICT",
                requestId: input.requestId,
              };
            await audit(transaction, {
              actor,
              action:
                inputValue.operation === "resource_grant.archive"
                  ? "resource_grant.archive"
                  : "resource_grant.update",
              requestId: input.requestId,
              resourceId: updated.id,
              resourceKind: "resource_grant",
              workspaceId: input.workspaceId,
            });
            return {
              id: updated.id,
              version: updated.version,
              code: "APPLIED",
              requestId: input.requestId,
            };
          },
        });
      });
    },
    archiveResourceGrant(
      id: string,
      expectedVersion: number,
      idempotencyKey?: string | null,
    ): Promise<PolicyMutationResult> {
      return this.updateResourceGrant({
        id,
        expectedVersion,
        idempotencyKey,
        operation: "resource_grant.archive",
        state: "archived",
      });
    },
    upsertRetentionPolicy(inputValue: {
      resourceKind: string;
      retentionDays: number;
      deletionBehavior: "review" | "soft_delete" | "hard_delete" | "anonymize";
      legalBasis?: string | null;
      expectedVersion?: number | null;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        const resourceKind = inputValue.resourceKind.trim().toLowerCase();
        if (
          !RESOURCE_KIND.test(resourceKind) ||
          !Number.isSafeInteger(inputValue.retentionDays) ||
          inputValue.retentionDays < 0 ||
          inputValue.retentionDays > 36500
        )
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Retention policy is invalid.",
          );
        const existing = await transaction
          .select({
            id: retentionPolicies.id,
            version: retentionPolicies.version,
          })
          .from(retentionPolicies)
          .where(
            and(
              eq(retentionPolicies.workspaceId, input.workspaceId),
              eq(retentionPolicies.resourceKind, resourceKind),
              isNull(retentionPolicies.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const current = existing[0];
        if (current) {
          if (
            inputValue.expectedVersion == null ||
            inputValue.expectedVersion !== current.version
          )
            return {
              id: null,
              version: null,
              code: "CONFLICT",
              requestId: input.requestId,
            };
          const [updated] = await transaction
            .update(retentionPolicies)
            .set({
              retentionDays: inputValue.retentionDays,
              deletionBehavior: inputValue.deletionBehavior,
              legalBasis: inputValue.legalBasis?.trim().slice(0, 512) ?? null,
              version: sql`${retentionPolicies.version} + 1`,
              updatedAt: new Date(),
              updatedBy: actor.id,
            })
            .where(
              and(
                eq(retentionPolicies.id, current.id),
                eq(retentionPolicies.version, current.version),
              ),
            )
            .returning({
              id: retentionPolicies.id,
              version: retentionPolicies.version,
            });
          if (!updated)
            return {
              id: null,
              version: null,
              code: "CONFLICT",
              requestId: input.requestId,
            };
          await audit(transaction, {
            actor,
            action: "retention_policy.update",
            requestId: input.requestId,
            resourceId: updated.id,
            resourceKind: "retention_policy",
            workspaceId: input.workspaceId,
          });
          return {
            id: updated.id,
            version: updated.version,
            code: "APPLIED",
            requestId: input.requestId,
          };
        }
        const id = newId();
        await transaction.insert(retentionPolicies).values({
          id,
          workspaceId: input.workspaceId,
          resourceKind,
          retentionDays: inputValue.retentionDays,
          deletionBehavior: inputValue.deletionBehavior,
          legalBasis: inputValue.legalBasis?.trim().slice(0, 512) ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        await audit(transaction, {
          actor,
          action: "retention_policy.create",
          requestId: input.requestId,
          resourceId: id,
          resourceKind: "retention_policy",
          workspaceId: input.workspaceId,
        });
        return { id, version: 1, code: "APPLIED", requestId: input.requestId };
      });
    },
    createLegalHold(inputValue: {
      resourceId: string;
      resourceKind: string;
      reason: string;
      authority: string;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        if (
          !RESOURCE_KIND.test(inputValue.resourceKind) ||
          inputValue.reason.trim().length < 1 ||
          inputValue.authority.trim().length < 1
        )
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Legal hold is invalid.",
          );
        const id = newId();
        await transaction.insert(legalHolds).values({
          id,
          workspaceId: input.workspaceId,
          resourceId: inputValue.resourceId,
          resourceKind: inputValue.resourceKind,
          reason: inputValue.reason.trim().slice(0, 2048),
          authority: inputValue.authority.trim().slice(0, 512),
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        await audit(transaction, {
          actor,
          action: "legal_hold.create",
          requestId: input.requestId,
          resourceId: id,
          resourceKind: "legal_hold",
          workspaceId: input.workspaceId,
        });
        return { id, version: 1, code: "APPLIED", requestId: input.requestId };
      });
    },
    releaseLegalHold(
      id: string,
      expectedVersion: number,
      releaseReason: string,
    ): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        const [updated] = await transaction
          .update(legalHolds)
          .set({
            state: "released",
            releasedAt: new Date(),
            releasedBy: actor.id,
            releaseReason: releaseReason.trim().slice(0, 2048),
            updatedAt: new Date(),
            updatedBy: actor.id,
            version: sql`${legalHolds.version} + 1`,
          })
          .where(
            and(
              eq(legalHolds.id, id),
              eq(legalHolds.workspaceId, input.workspaceId),
              eq(legalHolds.state, "active"),
              eq(legalHolds.version, expectedVersion),
            ),
          )
          .returning({ id: legalHolds.id, version: legalHolds.version });
        if (!updated)
          return {
            id: null,
            version: null,
            code: "CONFLICT",
            requestId: input.requestId,
          };
        await audit(transaction, {
          actor,
          action: "legal_hold.release",
          requestId: input.requestId,
          resourceId: updated.id,
          resourceKind: "legal_hold",
          workspaceId: input.workspaceId,
        });
        return {
          id: updated.id,
          version: updated.version,
          code: "APPLIED",
          requestId: input.requestId,
        };
      });
    },
    createConsent(inputValue: {
      personId: string;
      purpose: string;
      status: "granted" | "denied" | "withdrawn" | "expired" | "unknown";
      source: string;
      effectiveFrom: Date;
      effectiveUntil?: Date | null;
      evidenceId?: string | null;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        if (!inputValue.purpose.trim() || !inputValue.source.trim())
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Consent purpose and source are required.",
          );
        const id = newId();
        await transaction.insert(consentRecords).values({
          id,
          workspaceId: input.workspaceId,
          personId: inputValue.personId,
          purpose: inputValue.purpose.trim().slice(0, 512),
          status: inputValue.status,
          source: inputValue.source.trim().slice(0, 512),
          effectiveFrom: inputValue.effectiveFrom,
          effectiveUntil: inputValue.effectiveUntil ?? null,
          evidenceId: inputValue.evidenceId ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        await audit(transaction, {
          actor,
          action: "consent.create",
          requestId: input.requestId,
          resourceId: id,
          resourceKind: "consent",
          workspaceId: input.workspaceId,
        });
        return { id, version: 1, code: "APPLIED", requestId: input.requestId };
      });
    },
    createDeletionRequest(inputValue: {
      scope: unknown;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        if (
          !inputValue.scope ||
          typeof inputValue.scope !== "object" ||
          Array.isArray(inputValue.scope)
        )
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "Deletion scope is invalid.",
          );
        const id = newId();
        await transaction.insert(deletionRequests).values({
          id,
          workspaceId: input.workspaceId,
          requesterId: actor.id,
          scope: inputValue.scope,
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        await audit(transaction, {
          actor,
          action: "deletion_request.create",
          requestId: input.requestId,
          resourceId: id,
          resourceKind: "deletion_request",
          workspaceId: input.workspaceId,
        });
        return { id, version: 1, code: "APPLIED", requestId: input.requestId };
      });
    },
    reviewDeletionRequest(inputValue: {
      id: string;
      expectedVersion: number;
      state:
        | "reviewing"
        | "approved"
        | "rejected"
        | "exporting"
        | "deleting"
        | "completed"
        | "cancelled";
      notes?: string | null;
    }): Promise<PolicyMutationResult> {
      return mutation(async (transaction, actor) => {
        const [updated] = await transaction
          .update(deletionRequests)
          .set({
            state: inputValue.state,
            reviewedAt: new Date(),
            reviewedBy: actor.id,
            reviewNotes: inputValue.notes?.trim().slice(0, 2048) ?? null,
            completedAt: inputValue.state === "completed" ? new Date() : null,
            updatedAt: new Date(),
            updatedBy: actor.id,
            version: sql`${deletionRequests.version} + 1`,
          })
          .where(
            and(
              eq(deletionRequests.id, inputValue.id),
              eq(deletionRequests.workspaceId, input.workspaceId),
              eq(deletionRequests.version, inputValue.expectedVersion),
            ),
          )
          .returning({
            id: deletionRequests.id,
            version: deletionRequests.version,
          });
        if (!updated)
          return {
            id: null,
            version: null,
            code: "CONFLICT",
            requestId: input.requestId,
          };
        await audit(transaction, {
          actor,
          action: "deletion_request.review",
          requestId: input.requestId,
          resourceId: updated.id,
          resourceKind: "deletion_request",
          workspaceId: input.workspaceId,
        });
        return {
          id: updated.id,
          version: updated.version,
          code: "APPLIED",
          requestId: input.requestId,
        };
      });
    },
  };
}
