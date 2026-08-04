import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { evidenceItems } from "@/db/schema/evidence";
import { people } from "@/db/schema/people";
import { apiKeys, members } from "@/db/schema/auth";
import { workspacePrincipals } from "@/db/schema/principals";
import { workspaces } from "@/db/schema/workspaces";
import {
  visibleResourceIds,
  type ResearchActor,
} from "@/modules/audit/service";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  isWorkspaceRole,
  parseApiKeyPermissionKeys,
  rolePermissionKeys,
  type PermissionKey,
} from "@/modules/auth/permissions";
import type { AiScope } from "./repository-domain";

type AiReference = Readonly<{
  id: string;
  kind: "evidence" | "person";
}>;

export type AiCurrentAuthority = Readonly<{
  actor: Extract<ResearchActor, { type: "apiKey" | "user" }>;
  permissions: ReadonlySet<PermissionKey>;
  workspaceId: string;
}>;

export type AuthorizedAiReferences = Readonly<{
  authority: AiCurrentAuthority;
  references: readonly AiReference[];
}>;

async function currentAuthority(
  database: Database,
  input: { principalId: string; workspaceId: string },
): Promise<AiCurrentAuthority | null> {
  // The worker-only claimed job/run locks are already held by the caller.
  // After those, keep the global research-write order: live authority rows,
  // resource rows, then visibility grant/policy rows. Shared locks are held
  // through the caller's tool/citation transaction, so a concurrent revoke
  // either wins before this check or serializes after the authorized write.
  const userRows = await database
    .select({
      memberId: workspacePrincipals.memberIdSnapshot,
      principalId: workspacePrincipals.id,
      role: members.role,
      userId: workspacePrincipals.userId,
    })
    .from(workspacePrincipals)
    .innerJoin(
      members,
      and(
        eq(members.id, workspacePrincipals.memberIdSnapshot),
        eq(members.userId, workspacePrincipals.userId),
        eq(members.workspaceId, workspacePrincipals.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, members.workspaceId),
        eq(workspaces.organizationId, members.organizationId),
      ),
    )
    .where(
      and(
        eq(workspacePrincipals.id, input.principalId),
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.principalType, "user"),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(2)
    .for("share");
  const user = userRows[0];
  if (
    userRows.length === 1 &&
    user?.userId &&
    user.memberId &&
    isWorkspaceRole(user.role)
  ) {
    return Object.freeze({
      actor: Object.freeze({
        type: "user",
        id: user.userId,
        principalId: user.principalId,
        sessionId: "worker-current-authority",
        memberId: user.memberId,
        role: user.role,
      }),
      permissions: new Set(rolePermissionKeys(user.role)),
      workspaceId: input.workspaceId,
    });
  }
  const keyRows = await database
    .select({
      apiKeyId: workspacePrincipals.apiKeyId,
      permissions: apiKeys.permissions,
      principalId: workspacePrincipals.id,
    })
    .from(workspacePrincipals)
    .innerJoin(
      apiKeys,
      and(
        eq(apiKeys.id, workspacePrincipals.apiKeyId),
        eq(apiKeys.workspaceId, workspacePrincipals.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, apiKeys.workspaceId),
        eq(workspaces.organizationId, apiKeys.referenceId),
      ),
    )
    .where(
      and(
        eq(workspacePrincipals.id, input.principalId),
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.principalType, "api_key"),
        eq(apiKeys.configId, "organization"),
        eq(apiKeys.enabled, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(2)
    .for("share");
  const key = keyRows[0];
  if (keyRows.length === 1 && key?.apiKeyId) {
    return Object.freeze({
      actor: Object.freeze({
        type: "apiKey",
        id: key.apiKeyId,
        principalId: key.principalId,
        role: null,
      }),
      permissions: new Set(parseApiKeyPermissionKeys(key.permissions)),
      workspaceId: input.workspaceId,
    });
  }
  return null;
}

export async function authorizeAiReferences(
  database: Database,
  input: {
    principalId: string;
    references: readonly AiReference[];
    requiredPermissions?: readonly PermissionKey[];
    scope: AiScope;
    workspaceId: string;
  },
): Promise<AuthorizedAiReferences | null> {
  // Phase 1: lock live authority. The lock remains held by the caller's
  // transaction through every following phase and the eventual write.
  const authority = await currentAuthority(database, input);
  if (!authority) return null;
  if (
    input.requiredPermissions?.some(
      (permission) => !authority.permissions.has(permission),
    )
  ) {
    return null;
  }

  // Phase 2: collapse duplicates and establish the global kind/UUID order.
  const references = [
    ...new Map(
      input.references.map((reference) => [
        `${reference.kind}:${reference.id}`,
        { id: reference.id, kind: reference.kind },
      ]),
    ).values(),
  ].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "person" ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  if (references.length === 0) {
    return Object.freeze({
      authority,
      references: Object.freeze(references),
    });
  }
  const allowedPeople = new Set(input.scope.personIds);
  const allowedEvidence = new Set(input.scope.evidenceIds);
  if (
    references.some((reference) =>
      reference.kind === "person"
        ? !allowedPeople.has(reference.id)
        : !allowedEvidence.has(reference.id),
    )
  ) {
    return null;
  }
  const personIds = references
    .filter((reference) => reference.kind === "person")
    .map((reference) => reference.id);
  const evidenceIds = references
    .filter((reference) => reference.kind === "evidence")
    .map((reference) => reference.id);
  if (personIds.length && !authority.permissions.has("person:read")) {
    return null;
  }
  if (evidenceIds.length && !authority.permissions.has("evidence:read")) {
    return null;
  }

  // Phase 3: lock every resource row before consulting any grant. The kind
  // order is person then evidence; each query locks rows in ascending UUID.
  const personRows = personIds.length
    ? await database
        .select({ id: people.id, sensitivity: people.sensitivity })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            inArray(people.id, personIds),
            isNull(people.deletedAt),
          ),
        )
        .orderBy(asc(people.id))
        .for("share")
    : [];
  const evidenceRows = evidenceIds.length
    ? await database
        .select({
          id: evidenceItems.id,
          sensitivity: evidenceItems.sensitivity,
        })
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            inArray(evidenceItems.id, evidenceIds),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .orderBy(asc(evidenceItems.id))
        .for("share")
    : [];
  if (
    personRows.length !== personIds.length ||
    evidenceRows.length !== evidenceIds.length
  ) {
    return null;
  }

  // Phase 4: only after all resource locks are held, evaluate visibility and
  // take deterministic shared locks on every applicable grant/policy row.
  if (personRows.length) {
    const visible = await visibleResourceIds(database, authority, {
      lockGrants: true,
      resourceKind: "person",
      resources: personRows,
    });
    if (visible.size !== personIds.length) return null;
  }
  if (evidenceRows.length) {
    const visible = await visibleResourceIds(database, authority, {
      lockGrants: true,
      resourceKind: "evidence",
      resources: evidenceRows,
    });
    if (visible.size !== evidenceIds.length) return null;
  }
  return Object.freeze({
    authority,
    references: Object.freeze(references),
  });
}
