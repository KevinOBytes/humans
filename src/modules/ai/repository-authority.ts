import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";

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

type CurrentAuthority = Readonly<{
  actor: ResearchActor;
  permissions: ReadonlySet<PermissionKey>;
  workspaceId: string;
}>;

async function currentAuthority(
  database: Database,
  input: { principalId: string; workspaceId: string },
): Promise<CurrentAuthority | null> {
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
    return {
      actor: {
        type: "user",
        id: user.userId,
        principalId: user.principalId,
        sessionId: "worker-current-authority",
        memberId: user.memberId,
        role: user.role,
      },
      permissions: rolePermissionKeys(user.role),
      workspaceId: input.workspaceId,
    };
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
    return {
      actor: {
        type: "apiKey",
        id: key.apiKeyId,
        principalId: key.principalId,
        role: null,
      },
      permissions: parseApiKeyPermissionKeys(key.permissions),
      workspaceId: input.workspaceId,
    };
  }
  return null;
}

export async function authorizeAiReferences(
  database: Database,
  input: {
    principalId: string;
    references: readonly AiReference[];
    scope: AiScope;
    workspaceId: string;
  },
): Promise<boolean> {
  const authority = await currentAuthority(database, input);
  if (!authority) return false;
  if (input.references.length === 0) return true;
  const referenceKeys = input.references.map(
    (reference) => `${reference.kind}:${reference.id}`,
  );
  if (new Set(referenceKeys).size !== referenceKeys.length) return false;
  const allowedPeople = new Set(input.scope.personIds);
  const allowedEvidence = new Set(input.scope.evidenceIds);
  if (
    input.references.some((reference) =>
      reference.kind === "person"
        ? !allowedPeople.has(reference.id)
        : !allowedEvidence.has(reference.id),
    )
  ) {
    return false;
  }
  const personIds = input.references
    .filter((reference) => reference.kind === "person")
    .map((reference) => reference.id);
  const evidenceIds = input.references
    .filter((reference) => reference.kind === "evidence")
    .map((reference) => reference.id);
  if (personIds.length) {
    if (!authority.permissions.has("person:read")) return false;
    const rows = await database
      .select({ id: people.id, sensitivity: people.sensitivity })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, input.workspaceId),
          inArray(people.id, personIds),
          isNull(people.deletedAt),
        ),
      )
      .for("share");
    if (rows.length !== personIds.length) return false;
    const visible = await visibleResourceIds(database, authority, {
      lockGrants: true,
      resourceKind: "person",
      resources: rows,
    });
    if (visible.size !== personIds.length) return false;
  }
  if (evidenceIds.length) {
    if (!authority.permissions.has("evidence:read")) return false;
    const rows = await database
      .select({ id: evidenceItems.id, sensitivity: evidenceItems.sensitivity })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.workspaceId, input.workspaceId),
          inArray(evidenceItems.id, evidenceIds),
          isNull(evidenceItems.deletedAt),
        ),
      )
      .for("share");
    if (rows.length !== evidenceIds.length) return false;
    const visible = await visibleResourceIds(database, authority, {
      lockGrants: true,
      resourceKind: "evidence",
      resources: rows,
    });
    if (visible.size !== evidenceIds.length) return false;
  }
  return true;
}
