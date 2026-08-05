import type { GraphQLActor } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import type { BetterAuthRuntime } from "@/lib/auth/config";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { ensureApiKeyPrincipal } from "@/modules/auth/workspaces";
import {
  authorize,
  parsePermissionKey,
  type PermissionAction,
  type PermissionResource,
  type WorkspaceRole,
} from "@/modules/auth/permissions";
import {
  SETTINGS_PAGE_SIZE,
  buildSafeSettingsPage,
  normalizeSettingsOffset,
} from "@/modules/settings/pagination";
import { mapSafeApiKey } from "@/modules/settings/read-model";
import {
  apiKeyActionId,
  isApiKeyActionId,
  matchesApiKeyActionId,
} from "@/modules/settings/api-key-action-id";
import {
  createWorkspaceMemberAdministration,
  type WorkspaceMemberRuntime,
} from "@/modules/settings/workspace-members";

import { createSettingsRepository } from "./repository";
import { createPolicyMutationService } from "./policy-mutations";

export function createSettingsService(input: {
  actor: GraphQLActor;
  auth?: BetterAuthRuntime;
  database: Database;
  organizationId?: string;
  requestId?: string;
  runtime?: WorkspaceMemberRuntime;
  workspaceId: string;
}) {
  const repository = createSettingsRepository(input.database);
  // Read-only service callers in narrow tests do not receive the runtime. The
  // production GraphQL path always supplies AUTH_SECRET; lifecycle mutations
  // fail closed without it.
  const actionSecret = input.runtime?.authSecret ?? "settings-read-only";
  const requestId = input.requestId ?? crypto.randomUUID();
  const members = createWorkspaceMemberAdministration({
    ...input,
    requestId,
  });
  const policyMutations = createPolicyMutationService({
    actor: input.actor,
    database: input.database,
    requestId,
    workspaceId: input.workspaceId,
  });

  async function authorizeAdministrator(): Promise<"admin" | "owner"> {
    if (input.actor.type !== "user") {
      throw createGraphQLError(
        "FORBIDDEN",
        "Workspace settings require an administrator session.",
      );
    }
    const active = await repository.readAdministrativeMembership({
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
    return active.role;
  }

  function lifecycleUnavailable(): never {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "API-key administration is unavailable.",
    );
  }

  function lifecycleInput(inputValue: {
    expiresInSeconds?: number | null;
    name: string;
    scopes: readonly string[];
  }): {
    expiresIn?: number;
    name: string;
    permissions: Record<string, string[]>;
  } | null {
    const name = inputValue.name.normalize("NFKC").trim();
    if (
      name.length < 1 ||
      name.length > 100 ||
      Buffer.byteLength(name, "utf8") > 256 ||
      inputValue.scopes.length < 1 ||
      inputValue.scopes.length > 128
    ) {
      return null;
    }
    const expiresInSeconds = inputValue.expiresInSeconds;
    if (
      expiresInSeconds !== undefined &&
      expiresInSeconds !== null &&
      (!Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds < 3_600 ||
        expiresInSeconds > 366 * 24 * 60 * 60)
    ) {
      return null;
    }
    const permissions: Record<string, string[]> = {};
    for (const scope of inputValue.scopes) {
      const parsed = parsePermissionKey(scope);
      if (!parsed) return null;
      const actions = permissions[parsed.resource] ?? [];
      if (!actions.includes(parsed.action)) actions.push(parsed.action);
      permissions[parsed.resource] = actions;
    }
    return {
      name,
      permissions,
      ...(expiresInSeconds === undefined || expiresInSeconds === null
        ? {}
        : { expiresIn: expiresInSeconds }),
    };
  }

  function permittedPermissions(
    role: WorkspaceRole,
    permissions: Record<string, string[]>,
  ): boolean {
    return Object.entries(permissions).every(([resource, actions]) =>
      actions.every((action) =>
        authorize(
          role,
          resource as PermissionResource,
          action as PermissionAction,
        ),
      ),
    );
  }

  async function activeApiKeyForAction(actionId: string) {
    if (!isApiKeyActionId(actionId)) return null;
    const candidates = await repository.findOrganizationApiKeyCandidates(
      input.workspaceId,
    );
    const candidate = candidates.find((row) =>
      matchesApiKeyActionId({
        actionId,
        apiKeyId: row.id,
        secret: actionSecret,
        workspaceId: input.workspaceId,
      }),
    );
    if (
      !candidate ||
      candidate.enabled !== true ||
      (candidate.expiresAt !== null && candidate.expiresAt <= new Date())
    ) {
      return null;
    }
    return candidate;
  }

  async function createApiKey(
    inputValue: {
      expiresInSeconds?: number | null;
      name: string;
      scopes: readonly string[];
    },
    options: { recordCreateAudit?: boolean } = {},
  ) {
    await authorizeAdministrator();
    const actor = input.actor;
    if (actor.type !== "user") lifecycleUnavailable();
    const auth = input.auth;
    const runtime = input.runtime;
    const organizationId = input.organizationId;
    if (!auth || !runtime || !organizationId) {
      lifecycleUnavailable();
    }
    const validated = lifecycleInput(inputValue);
    if (!validated) {
      return {
        _createdApiKeyId: null,
        actionId: null,
        code: "INVALID",
        requestId,
      } as const;
    }

    let created:
      Awaited<ReturnType<BetterAuthRuntime["api"]["createApiKey"]>> | undefined;
    try {
      await runtime.beforeApiKeyLifecycleWrite?.();
      const finalized = await repository.withAdministrativeApiKeyLifecycle({
        actor,
        workspaceId: input.workspaceId,
        run: async (transaction, role) => {
          if (!permittedPermissions(role, validated.permissions)) return null;
          created = await auth.api.createApiKey({
            body: {
              configId: "organization",
              name: validated.name,
              organizationId,
              permissions: validated.permissions,
              userId: actor.id,
              ...(validated.expiresIn === undefined
                ? {}
                : { expiresIn: validated.expiresIn }),
            },
          });
          await runtime.afterApiKeyLifecycleStep?.("created");
          await repository.disableCreatedOrganizationApiKey({
            apiKeyId: created.id,
            workspaceId: input.workspaceId,
          });
          await runtime.afterApiKeyLifecycleStep?.("staged");
          const activated = await repository.activateCreatedOrganizationApiKey({
            apiKeyId: created.id,
            transaction,
            workspaceId: input.workspaceId,
          });
          if (!activated)
            throw new Error("Created API key could not be activated");
          await ensureApiKeyPrincipal(transaction as unknown as Database, {
            apiKeyId: created.id,
            workspaceId: input.workspaceId,
          });
          if (options.recordCreateAudit !== false) {
            await runtime.afterApiKeyLifecycleStep?.("before_audit");
            await repository.recordApiKeyLifecycleAudit({
              action: "settings.api_key.create",
              actor,
              changedFields: ["created", "permissions", "expiry"],
              requestId,
              transaction,
              workspaceId: input.workspaceId,
            });
          }
          return created;
        },
      });
      if (finalized.status !== "APPLIED" || !finalized.value) {
        return {
          _createdApiKeyId: null,
          actionId: null,
          code: "INVALID",
          requestId,
        } as const;
      }
    } catch {
      if (created) {
        await cleanupCreatedApiKey(created.id);
      }
      throw createGraphQLError("INTERNAL", "The API key could not be created.");
    }
    if (!created) lifecycleUnavailable();
    return {
      _createdApiKeyId: created.id,
      actionId: apiKeyActionId({
        apiKeyId: created.id,
        secret: actionSecret,
        workspaceId: input.workspaceId,
      }),
      code: "APPLIED",
      requestId,
      secret: created.key,
    } as const;
  }

  return {
    directory: members.directory,
    issueInvitation: members.issueInvitation,
    resendInvitation: members.resendInvitation,
    cancelInvitation: members.cancelInvitation,
    updateMemberRole: members.updateMemberRole,
    removeMember: members.removeMember,
    policyMutations,
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
          actionId: apiKeyActionId({
            apiKeyId: row.id,
            secret: actionSecret,
            workspaceId: input.workspaceId,
          }),
          permissions: parsePermissions(row.permissions),
        }),
      );
      return {
        ...buildSafeSettingsPage(nodes, offset, result.total),
        allowedScopes: allowedScopesForRole(input.actor.role),
      };
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
    async readWorkspacePolicySummary() {
      const summary = await repository.readWorkspacePolicySummary(
        input.workspaceId,
      );
      if (!summary) {
        throw createGraphQLError(
          "NOT_FOUND",
          "Workspace settings are unavailable.",
        );
      }
      return summary;
    },
    async createOrganizationApiKey(inputValue: {
      expiresInSeconds?: number | null;
      name: string;
      scopes: readonly string[];
    }) {
      return createApiKey(inputValue);
    },
    async rotateOrganizationApiKey(inputValue: {
      actionId: string;
      expiresInSeconds?: number | null;
      name: string;
      scopes: readonly string[];
    }) {
      await authorizeAdministrator();
      const current = await activeApiKeyForAction(inputValue.actionId);
      if (!current) {
        return { actionId: null, code: "INVALID", requestId } as const;
      }
      const replacement = await createApiKey(inputValue, {
        recordCreateAudit: false,
      });
      if (
        replacement.code !== "APPLIED" ||
        !replacement.actionId ||
        !replacement._createdApiKeyId
      ) {
        return replacement;
      }
      const actor = input.actor;
      if (actor.type !== "user") lifecycleUnavailable();
      try {
        await input.runtime?.beforeApiKeyLifecycleWrite?.();
        await input.runtime?.afterApiKeyLifecycleStep?.(
          "before_rotation_disable",
        );
        const rotated = await repository.disableOrganizationApiKeyWithAudit({
          action: "settings.api_key.rotate",
          apiKeyId: current.id,
          actor,
          changedFields: ["replacement", "enabled"],
          requestId,
          workspaceId: input.workspaceId,
        });
        if (rotated !== "APPLIED") {
          await cleanupCreatedApiKey(replacement._createdApiKeyId);
          return { actionId: null, code: "INVALID", requestId } as const;
        }
      } catch {
        await cleanupCreatedApiKey(replacement._createdApiKeyId);
        throw createGraphQLError(
          "INTERNAL",
          "The API key could not be rotated.",
        );
      }
      return replacement;
    },
    async revokeOrganizationApiKey(actionId: string) {
      await authorizeAdministrator();
      const current = await activeApiKeyForAction(actionId);
      const actor = input.actor;
      if (!current) {
        return { actionId: null, code: "INVALID", requestId } as const;
      }
      if (actor.type !== "user") lifecycleUnavailable();
      try {
        await input.runtime?.beforeApiKeyLifecycleWrite?.();
        const revoked = await repository.disableOrganizationApiKeyWithAudit({
          action: "settings.api_key.revoke",
          apiKeyId: current.id,
          actor,
          changedFields: ["enabled"],
          requestId,
          workspaceId: input.workspaceId,
        });
        return {
          actionId: revoked === "APPLIED" ? actionId : null,
          code: revoked === "APPLIED" ? "APPLIED" : "INVALID",
          requestId,
        } as const;
      } catch {
        throw createGraphQLError(
          "INTERNAL",
          "The API key could not be revoked.",
        );
      }
    },
  };

  async function cleanupCreatedApiKey(apiKeyId: string): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await repository.disableCreatedOrganizationApiKey({
          apiKeyId,
          workspaceId: input.workspaceId,
        });
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }
}

function allowedScopesForRole(role: GraphQLActor["role"]): readonly string[] {
  if (!role) return [];
  const resources: PermissionResource[] = [
    "person",
    "contactPoint",
    "place",
    "address",
    "fact",
    "relationship",
    "evidence",
    "source",
    "file",
    "import",
    "note",
    "tag",
    "search",
    "graph",
    "savedQuery",
    "graphView",
    "analysis",
  ];
  return resources
    .flatMap((resource) =>
      [
        "create",
        "read",
        "update",
        "delete",
        "merge",
        "supersede",
        "select",
        "run",
        "cancel",
      ]
        .filter((action) =>
          authorize(role, resource, action as PermissionAction),
        )
        .map((action) => `${resource}:${action}`),
    )
    .sort();
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
