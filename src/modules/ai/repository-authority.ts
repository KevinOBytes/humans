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
  const [principal] = await database
    .select()
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.id, input.principalId),
        eq(workspacePrincipals.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!principal) return null;
  if (
    principal.principalType === "user" &&
    principal.userId &&
    principal.memberIdSnapshot
  ) {
    const [membership] = await database
      .select({ role: members.role })
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
          eq(members.id, principal.memberIdSnapshot),
          eq(members.userId, principal.userId),
          eq(members.workspaceId, input.workspaceId),
          eq(workspaces.state, "active"),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!membership || !isWorkspaceRole(membership.role)) return null;
    return {
      actor: {
        type: "user",
        id: principal.userId,
        principalId: principal.id,
        sessionId: "worker-current-authority",
        memberId: principal.memberIdSnapshot,
        role: membership.role,
      },
      permissions: rolePermissionKeys(membership.role),
      workspaceId: input.workspaceId,
    };
  }
  if (principal.principalType === "api_key" && principal.apiKeyId) {
    const [key] = await database
      .select({ permissions: apiKeys.permissions })
      .from(apiKeys)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, apiKeys.workspaceId),
          eq(workspaces.organizationId, apiKeys.referenceId),
        ),
      )
      .where(
        and(
          eq(apiKeys.id, principal.apiKeyId),
          eq(apiKeys.workspaceId, input.workspaceId),
          eq(apiKeys.configId, "organization"),
          eq(apiKeys.enabled, true),
          or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          eq(workspaces.state, "active"),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!key) return null;
    return {
      actor: {
        type: "apiKey",
        id: principal.apiKeyId,
        principalId: principal.id,
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
  const authority = await currentAuthority(database, input);
  if (!authority) return false;
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
      );
    if (rows.length !== personIds.length) return false;
    const visible = await visibleResourceIds(database, authority, {
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
      );
    if (rows.length !== evidenceIds.length) return false;
    const visible = await visibleResourceIds(database, authority, {
      resourceKind: "evidence",
      resources: rows,
    });
    if (visible.size !== evidenceIds.length) return false;
  }
  return true;
}
