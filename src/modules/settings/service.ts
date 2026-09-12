import type { GraphQLActor } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import type { BetterAuthRuntime } from "@/lib/auth/config";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { ensureApiKeyPrincipal } from "@/modules/auth/workspaces";
import {
  authorize,
  parsePermissionKey,
  type PermissionKey,
  type PermissionAction,
  type PermissionResource,
  type WorkspaceRole,
} from "@/modules/auth/permissions";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
} from "@/modules/audit/transactions";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
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

import {
  createSettingsRepository,
  type TransactionDatabase,
} from "./repository";
import { createPolicyMutationService } from "./policy-mutations";

const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createSettingsService(input: {
  actor: GraphQLActor;
  auth?: BetterAuthRuntime;
  database: Database;
  organizationId?: string;
  idempotencyHmacKey?: string;
  permissions?: ReadonlySet<PermissionKey>;
  requestId?: string;
  runtime?: WorkspaceMemberRuntime;
  searchIndexMaintenance?: SearchIndexMaintenance;
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
    idempotencySecret: input.runtime?.authSecret,
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

  async function activeApiKeyForAction(
    actionId: string,
    scopedRepository = repository,
  ) {
    if (!isApiKeyActionId(actionId)) return null;
    const candidates = await scopedRepository.findOrganizationApiKeyCandidates(
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
      | Awaited<
          ReturnType<typeof repository.createOrganizationApiKeyInTransaction>
        >
      | undefined;
    try {
      await runtime.beforeApiKeyLifecycleWrite?.();
      const finalized = await repository.withAdministrativeApiKeyLifecycle({
        actor,
        workspaceId: input.workspaceId,
        run: async (transaction, role) => {
          if (!permittedPermissions(role, validated.permissions)) return null;
          created = await repository.createOrganizationApiKeyInTransaction({
            expiresInSeconds: validated.expiresIn,
            name: validated.name,
            organizationId,
            permissions: validated.permissions,
            transaction,
            workspaceId: input.workspaceId,
          });
          await runtime.afterApiKeyLifecycleStep?.("created");
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
        try {
          await cleanupCreatedApiKey(created.id);
        } catch {
          // Preserve the stable public error envelope even if compensating
          // cleanup exhausts its retries.
        }
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

  function idempotencyContext() {
    const actor = input.actor;
    if (actor.type !== "user") lifecycleUnavailable();
    if (
      !input.idempotencyHmacKey ||
      !input.permissions ||
      !input.searchIndexMaintenance
    ) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "API-key lifecycle idempotency is unavailable.",
      );
    }
    return {
      actor,
      database: input.database,
      permissions: input.permissions,
      requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.workspaceId,
    };
  }

  function validateLifecycleResponseReference(reference: {
    readonly [key: string]: boolean | null | number | string;
  }): {
    actionId: string | null;
    code: "APPLIED" | "INVALID";
    requestId: string;
  } {
    const exactKeys = Object.keys(reference).sort().join(":");
    const validActionId =
      reference.actionId === null ||
      (typeof reference.actionId === "string" &&
        isApiKeyActionId(reference.actionId));
    const coherentOutcome =
      (reference.code === "APPLIED" &&
        typeof reference.actionId === "string") ||
      (reference.code === "INVALID" && reference.actionId === null);
    if (
      exactKeys !== "actionId:code:requestId" ||
      !validActionId ||
      !coherentOutcome ||
      typeof reference.requestId !== "string" ||
      !REQUEST_ID.test(reference.requestId)
    ) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The stored API-key lifecycle result is invalid.",
      );
    }
    return {
      actionId: reference.actionId as string | null,
      code: reference.code as "APPLIED" | "INVALID",
      requestId: reference.requestId,
    };
  }

  async function createApiKeyIdempotently(inputValue: {
    expiresInSeconds?: number | null;
    idempotencyKey: string;
    name: string;
    scopes: readonly string[];
  }) {
    const role = await authorizeAdministrator();
    const actor = input.actor;
    const runtime = input.runtime;
    const organizationId = input.organizationId;
    if (actor.type !== "user" || !input.auth || !runtime || !organizationId) {
      lifecycleUnavailable();
    }
    const validated = lifecycleInput(inputValue);
    if (!validated || !permittedPermissions(role, validated.permissions)) {
      return {
        actionId: null,
        code: "INVALID",
        replayed: false,
        requestId,
      } as const;
    }
    const context = idempotencyContext();
    const claim = derivePrincipalResearchIdempotency(context, {
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      idempotencyKey: inputValue.idempotencyKey,
      operation: "settings.api_key.create",
      requestMaterial: {
        expiresInSeconds: validated.expiresIn ?? null,
        name: validated.name,
        scopes: Object.entries(validated.permissions)
          .flatMap(([resource, actions]) =>
            actions.map((action) => `${resource}:${action}`),
          )
          .sort(),
      },
      secret: input.idempotencyHmacKey!,
    });
    await runtime.beforeApiKeyLifecycleWrite?.();
    let transientSecret: string | undefined;
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      claim,
      ["apiKey:create"],
      async (scopedContext) => {
        // The idempotency runner exposes the narrowed context through the
        // shared Database interface, but invokes this callback inside its
        // outermost PostgreSQL transaction.
        const transaction =
          scopedContext.database as unknown as TransactionDatabase;
        const scopedRepository = createSettingsRepository(
          scopedContext.database,
        );
        const created =
          await scopedRepository.createOrganizationApiKeyInTransaction({
            expiresInSeconds: validated.expiresIn,
            name: validated.name,
            organizationId,
            permissions: validated.permissions,
            transaction,
            workspaceId: input.workspaceId,
          });
        await runtime.afterApiKeyLifecycleStep?.("created");
        await runtime.afterApiKeyLifecycleStep?.("staged");
        const activated =
          await scopedRepository.activateCreatedOrganizationApiKey({
            apiKeyId: created.id,
            transaction,
            workspaceId: input.workspaceId,
          });
        if (!activated)
          throw new Error("Created API key could not be activated");
        await ensureApiKeyPrincipal(
          scopedContext.database as unknown as Database,
          { apiKeyId: created.id, workspaceId: input.workspaceId },
        );
        await runtime.afterApiKeyLifecycleStep?.("before_audit");
        await scopedRepository.recordApiKeyLifecycleAudit({
          action: "settings.api_key.create",
          actor,
          changedFields: ["created", "permissions", "expiry"],
          requestId,
          transaction,
          workspaceId: input.workspaceId,
        });
        transientSecret = created.key;
        return {
          actionId: apiKeyActionId({
            apiKeyId: created.id,
            secret: actionSecret,
            workspaceId: input.workspaceId,
          }),
          code: "APPLIED",
          requestId,
        } as const;
      },
    );
    const reference = validateLifecycleResponseReference(
      executed.responseReference,
    );
    return {
      ...reference,
      replayed: executed.replayed,
      ...(!executed.replayed && transientSecret
        ? { secret: transientSecret }
        : {}),
    } as const;
  }

  async function rotateApiKeyIdempotently(inputValue: {
    actionId: string;
    expiresInSeconds?: number | null;
    idempotencyKey: string;
    name: string;
    scopes: readonly string[];
  }) {
    const role = await authorizeAdministrator();
    const actor = input.actor;
    const runtime = input.runtime;
    const organizationId = input.organizationId;
    if (actor.type !== "user" || !input.auth || !runtime || !organizationId) {
      lifecycleUnavailable();
    }
    const validated = lifecycleInput(inputValue);
    if (!validated || !permittedPermissions(role, validated.permissions)) {
      return {
        actionId: null,
        code: "INVALID",
        replayed: false,
        requestId,
      } as const;
    }
    const context = idempotencyContext();
    const claim = derivePrincipalResearchIdempotency(context, {
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      idempotencyKey: inputValue.idempotencyKey,
      operation: "settings.api_key.rotate",
      requestMaterial: {
        actionId: inputValue.actionId,
        expiresInSeconds: validated.expiresIn ?? null,
        name: validated.name,
        scopes: Object.entries(validated.permissions)
          .flatMap(([resource, actions]) =>
            actions.map((action) => `${resource}:${action}`),
          )
          .sort(),
      },
      secret: input.idempotencyHmacKey!,
    });
    await runtime.beforeApiKeyLifecycleWrite?.();
    let transientSecret: string | undefined;
    const executed = await runPrincipalIdempotentResearchWrite(
      context,
      claim,
      ["apiKey:create", "apiKey:delete"],
      async (scopedContext) => {
        const transaction =
          scopedContext.database as unknown as TransactionDatabase;
        const scopedRepository = createSettingsRepository(
          scopedContext.database,
        );
        const current = await activeApiKeyForAction(
          inputValue.actionId,
          scopedRepository,
        );
        if (!current) {
          return { actionId: null, code: "INVALID", requestId } as const;
        }
        const created =
          await scopedRepository.createOrganizationApiKeyInTransaction({
            expiresInSeconds: validated.expiresIn,
            name: validated.name,
            organizationId,
            permissions: validated.permissions,
            transaction,
            workspaceId: input.workspaceId,
          });
        await runtime.afterApiKeyLifecycleStep?.("created");
        await runtime.afterApiKeyLifecycleStep?.("staged");
        const activated =
          await scopedRepository.activateCreatedOrganizationApiKey({
            apiKeyId: created.id,
            transaction,
            workspaceId: input.workspaceId,
          });
        if (!activated)
          throw new Error("Created API key could not be activated");
        await ensureApiKeyPrincipal(
          scopedContext.database as unknown as Database,
          { apiKeyId: created.id, workspaceId: input.workspaceId },
        );
        await runtime.afterApiKeyLifecycleStep?.("before_rotation_disable");
        const rotated =
          await scopedRepository.disableOrganizationApiKeyInAuthorizedTransaction(
            {
              action: "settings.api_key.rotate",
              apiKeyId: current.id,
              actor,
              changedFields: ["replacement", "enabled"],
              requestId,
              transaction,
              workspaceId: input.workspaceId,
            },
          );
        if (rotated !== "APPLIED") {
          throw new Error("Original API key could not be disabled");
        }
        transientSecret = created.key;
        return {
          actionId: apiKeyActionId({
            apiKeyId: created.id,
            secret: actionSecret,
            workspaceId: input.workspaceId,
          }),
          code: "APPLIED",
          requestId,
        } as const;
      },
    );
    const reference = validateLifecycleResponseReference(
      executed.responseReference,
    );
    return {
      ...reference,
      replayed: executed.replayed,
      ...(!executed.replayed && transientSecret
        ? { secret: transientSecret }
        : {}),
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
      idempotencyKey?: string | null;
      name: string;
      scopes: readonly string[];
    }) {
      if (inputValue.idempotencyKey != null) {
        return createApiKeyIdempotently({
          ...inputValue,
          idempotencyKey: inputValue.idempotencyKey,
        });
      }
      return createApiKey(inputValue);
    },
    async rotateOrganizationApiKey(inputValue: {
      actionId: string;
      expiresInSeconds?: number | null;
      idempotencyKey?: string | null;
      name: string;
      scopes: readonly string[];
    }) {
      if (inputValue.idempotencyKey != null) {
        return rotateApiKeyIdempotently({
          ...inputValue,
          idempotencyKey: inputValue.idempotencyKey,
        });
      }
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
          try {
            await cleanupCreatedApiKey(replacement._createdApiKeyId);
          } catch {
            // Cleanup is best effort; return the stable mutation outcome.
          }
          return { actionId: null, code: "INVALID", requestId } as const;
        }
      } catch {
        try {
          await cleanupCreatedApiKey(replacement._createdApiKeyId);
        } catch {
          // Preserve the stable public error envelope on cleanup failure.
        }
        throw createGraphQLError(
          "INTERNAL",
          "The API key could not be rotated.",
        );
      }
      return replacement;
    },
    async revokeOrganizationApiKey(
      actionId: string,
      idempotencyKey?: string | null,
    ) {
      await authorizeAdministrator();
      const actor = input.actor;
      if (actor.type !== "user") lifecycleUnavailable();
      if (idempotencyKey != null) {
        if (
          !input.idempotencyHmacKey ||
          !input.permissions ||
          !input.searchIndexMaintenance
        ) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "API-key revocation idempotency is unavailable.",
          );
        }
        const context = {
          actor,
          database: input.database,
          permissions: input.permissions,
          requestId,
          searchIndexMaintenance: input.searchIndexMaintenance,
          workspaceId: input.workspaceId,
        };
        const claim = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
          idempotencyKey,
          operation: "settings.api_key.revoke",
          requestMaterial: { actionId },
          secret: input.idempotencyHmacKey,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          claim,
          ["apiKey:delete"],
          async (scopedContext) => {
            const scopedRepository = createSettingsRepository(
              scopedContext.database,
            );
            const current = await activeApiKeyForAction(
              actionId,
              scopedRepository,
            );
            if (!current) {
              return { actionId: null, code: "INVALID", requestId };
            }
            const revoked =
              await scopedRepository.disableOrganizationApiKeyInAuthorizedTransaction(
                {
                  action: "settings.api_key.revoke",
                  apiKeyId: current.id,
                  actor,
                  changedFields: ["enabled"],
                  requestId,
                  transaction: scopedContext.database,
                  workspaceId: input.workspaceId,
                },
              );
            return {
              actionId: revoked === "APPLIED" ? actionId : null,
              code: revoked === "APPLIED" ? "APPLIED" : "INVALID",
              requestId,
            };
          },
        );
        const reference = executed.responseReference;
        const validActionId =
          reference.actionId === null ||
          (typeof reference.actionId === "string" &&
            isApiKeyActionId(reference.actionId));
        const coherentOutcome =
          (reference.code === "APPLIED" &&
            typeof reference.actionId === "string") ||
          (reference.code === "INVALID" && reference.actionId === null);
        if (
          !validActionId ||
          !coherentOutcome ||
          typeof reference.requestId !== "string" ||
          !REQUEST_ID.test(reference.requestId)
        ) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The stored API-key revocation result is invalid.",
          );
        }
        return {
          actionId: reference.actionId,
          code: reference.code as "APPLIED" | "INVALID",
          requestId: reference.requestId,
        } as const;
      }
      const current = await activeApiKeyForAction(actionId);
      if (!current) {
        return { actionId: null, code: "INVALID", requestId } as const;
      }
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
