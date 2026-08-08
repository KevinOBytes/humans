import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { apiKeys, members, organizations, users } from "@/db/schema/auth";
import { workspacePrincipals } from "@/db/schema/principals";
import { workspaceSettings, workspaces } from "@/db/schema/workspaces";
import type { BetterAuthRuntime } from "@/lib/auth/config";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  authorize,
  isWorkspaceRole,
  permissionStatements,
  type PermissionAction,
  type PermissionResource,
  type WorkspaceRole,
} from "@/modules/auth/permissions";

export type WorkspaceIdentity = {
  organizationId: string;
  workspaceId: string;
  memberId: string;
  principalId: string;
};

export type ActiveWorkspace = {
  organizationId: string;
  workspaceId: string;
  memberId: string;
  userId: string;
  role: WorkspaceRole;
};

export type ApiKeyPermissions = Readonly<
  Partial<Record<PermissionResource, readonly PermissionAction[]>>
>;

function activeMembershipError(): Error {
  return new Error("Active workspace membership is required");
}

function activeApiKeyError(): Error {
  return new Error("Active API key is required");
}

export async function ensureUserPrincipal(
  database: Database,
  input: { workspaceId: string; memberId: string; userId: string },
): Promise<string> {
  const [membership] = await database
    .select({ id: members.id })
    .from(members)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, members.workspaceId),
        eq(workspaces.organizationId, members.organizationId),
      ),
    )
    .where(
      and(
        eq(members.workspaceId, input.workspaceId),
        eq(members.id, input.memberId),
        eq(members.userId, input.userId),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!membership) throw activeMembershipError();

  const [existing] = await database
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.userId, input.userId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = newId();
  await database
    .insert(workspacePrincipals)
    .values({
      id,
      workspaceId: input.workspaceId,
      principalType: "user",
      userId: input.userId,
      memberIdSnapshot: input.memberId,
    })
    .onConflictDoNothing();

  const [principal] = await database
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.userId, input.userId),
      ),
    )
    .limit(1);
  if (!principal) throw activeMembershipError();
  return principal.id;
}

export async function ensureApiKeyPrincipal(
  database: Database,
  input: { workspaceId: string; apiKeyId: string },
): Promise<string> {
  const [activeKey] = await database
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.workspaceId, input.workspaceId),
        eq(apiKeys.id, input.apiKeyId),
        eq(apiKeys.enabled, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (!activeKey) throw activeApiKeyError();

  const [existing] = await database
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.apiKeyId, input.apiKeyId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = newId();
  await database
    .insert(workspacePrincipals)
    .values({
      id,
      workspaceId: input.workspaceId,
      principalType: "api_key",
      apiKeyId: input.apiKeyId,
    })
    .onConflictDoNothing();

  const [principal] = await database
    .select({ id: workspacePrincipals.id })
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.apiKeyId, input.apiKeyId),
      ),
    )
    .limit(1);
  if (!principal) throw activeApiKeyError();
  return principal.id;
}

export async function provisionWorkspace(
  database: Database,
  input: { userId: string; name: string; slug: string },
): Promise<WorkspaceIdentity> {
  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]{2,62}$/u.test(slug)) {
    throw new Error("A valid workspace name and slug are required");
  }

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`humans:workspace:${slug}`}))`,
    );
    const [user] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!user) throw new Error("Workspace owner does not exist");

    const [slugTaken] = await transaction
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (slugTaken) throw new Error("Workspace slug is already in use");

    const organizationId = newId();
    const workspaceId = newId();
    const memberId = newId();
    const principalId = newId();
    const now = new Date();

    await transaction.insert(organizations).values({
      id: organizationId,
      name,
      slug,
      createdAt: now,
    });
    await transaction.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name,
      createdBy: input.userId,
      updatedBy: input.userId,
    });
    await transaction.insert(members).values({
      id: memberId,
      organizationId,
      userId: input.userId,
      role: "owner",
      createdAt: now,
      workspaceId,
    });
    await transaction.insert(workspacePrincipals).values({
      id: principalId,
      workspaceId,
      principalType: "user",
      userId: input.userId,
      memberIdSnapshot: memberId,
    });
    await transaction.insert(workspaceSettings).values({
      id: newId(),
      workspaceId,
      createdBy: input.userId,
      updatedBy: input.userId,
    });

    return { organizationId, workspaceId, memberId, principalId };
  });
}

export async function resolveActiveWorkspace(input: {
  auth: BetterAuthRuntime;
  database: Database;
  headers: Headers;
}): Promise<ActiveWorkspace> {
  const session = await input.auth.api.getSession({ headers: input.headers });
  const organizationId = session?.session.activeOrganizationId;
  if (!session || !organizationId) throw activeMembershipError();

  const [active] = await input.database
    .select({
      organizationId: workspaces.organizationId,
      workspaceId: workspaces.id,
      memberId: members.id,
      userId: members.userId,
      role: members.role,
    })
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
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
        eq(members.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!active || !isWorkspaceRole(active.role)) throw activeMembershipError();
  return { ...active, role: active.role };
}

function assertPermissionSubset(
  role: WorkspaceRole,
  permissions: ApiKeyPermissions,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [resource, requestedActions] of Object.entries(permissions)) {
    if (!Object.hasOwn(permissionStatements, resource) || !requestedActions) {
      throw new Error("API key permissions exceed the actor's authority");
    }
    const uniqueActions = [...new Set(requestedActions)];
    for (const action of uniqueActions) {
      if (
        !authorize(
          role,
          resource as PermissionResource,
          action as PermissionAction,
        )
      ) {
        throw new Error("API key permissions exceed the actor's authority");
      }
    }
    normalized[resource] = uniqueActions;
  }
  if (
    Object.keys(normalized).length === 0 ||
    Object.values(normalized).every((actions) => actions.length === 0)
  ) {
    throw new Error("At least one API key permission is required");
  }
  return normalized;
}

export async function provisionOrganizationApiKey(input: {
  auth: BetterAuthRuntime;
  database: Database;
  headers: Headers;
  name: string;
  permissions: ApiKeyPermissions;
  expiresIn?: number;
}) {
  const active = await resolveActiveWorkspace(input);
  if (!authorize(active.role, "apiKey", "create")) {
    throw new Error("API key creation is not permitted");
  }
  const permissions = assertPermissionSubset(active.role, input.permissions);
  const created = await input.auth.api.createApiKey({
    body: {
      configId: "organization",
      name: input.name.trim(),
      organizationId: active.organizationId,
      userId: active.userId,
      permissions,
      ...(input.expiresIn === undefined ? {} : { expiresIn: input.expiresIn }),
    },
  });
  // Better Auth's API-key plugin stores `start` with the prefix included,
  // while this application's read model stores the prefix separately. Keep
  // the persisted fingerprint canonical for keys created through this
  // compatibility boundary; the hash and one-time secret remain unchanged.
  if (
    created.prefix &&
    created.key?.startsWith(created.prefix) &&
    created.key.length > created.prefix.length
  ) {
    await input.database
      .update(apiKeys)
      .set({
        start: created.key.slice(
          created.prefix.length,
          created.prefix.length + 6,
        ),
      })
      .where(eq(apiKeys.id, created.id));
  }
  await ensureApiKeyPrincipal(input.database, {
    workspaceId: active.workspaceId,
    apiKeyId: created.id,
  });
  return created;
}

export async function verifyOrganizationApiKey(input: {
  auth: BetterAuthRuntime;
  database: Database;
  key: string;
  workspaceId: string;
  requiredPermission?: {
    resource: PermissionResource;
    action: PermissionAction;
  };
}): Promise<{ apiKeyId: string; organizationId: string; workspaceId: string }> {
  const result = await input.auth.api.verifyApiKey({
    body: { configId: "organization", key: input.key },
  });
  if (!result.valid || !result.key) throw new Error("API key is invalid");

  const [stored] = await input.database
    .select({
      apiKeyId: apiKeys.id,
      organizationId: apiKeys.referenceId,
      workspaceId: apiKeys.workspaceId,
      enabled: apiKeys.enabled,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, result.key.id))
    .limit(1);
  if (
    !stored ||
    !stored.enabled ||
    (stored.expiresAt !== null && stored.expiresAt <= new Date())
  ) {
    throw new Error("API key is invalid");
  }
  if (stored.workspaceId !== input.workspaceId) {
    throw new Error("API key is not valid for this workspace");
  }
  if (input.requiredPermission) {
    const allowed = result.key.permissions?.[input.requiredPermission.resource];
    if (!allowed?.includes(input.requiredPermission.action)) {
      throw new Error("API key permission is required");
    }
  }

  return stored;
}
