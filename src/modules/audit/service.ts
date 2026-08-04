import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { newId } from "@/db/id";
import { apiKeys, users } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import { workspacePrincipals } from "@/db/schema/principals";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import { createGraphQLError } from "@/graphql/errors";
import { decodeResearchCursor, normalizePagination } from "@/graphql/limits";
import type { Database } from "@/modules/auth/bootstrap-admin";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";

import { redactAuditDiff, type AuditSensitivity } from "./redaction";
import { getTrustedWorkerAuditContext } from "./transactions";

export type ResearchActor =
  | {
      type: "user";
      id: string;
      principalId: string;
      sessionId: string;
      memberId: string;
      role: string;
    }
  | {
      type: "apiKey";
      id: string;
      principalId: string;
      role: null;
    }
  | {
      type: "worker";
      id: string;
      principalId: string;
      memberId: string;
      role: string;
      importId: string;
      importRowId: string;
      jobId: string;
      leaseExpiresAt: string;
      leaseOwner: string;
      fencingToken: number;
      operation: "PERSON" | "RELATIONSHIP";
    };

export type ResearchServiceContext = {
  actor: ResearchActor;
  database: Database;
  permissions: ReadonlySet<string>;
  requestId: string;
  searchIndexMaintenance: SearchIndexMaintenance;
  workspaceId: string;
};

export type AuditableDatabase = Database;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ActorAttribution = {
  principalId: string | null;
  kind: "USER" | "API_KEY" | "LEGACY" | "SYSTEM";
  label: string;
};

const workerAuditActions = {
  PERSON: new Set([
    "person.create",
    "fact.create",
    "personName.create",
    "externalRecord.create",
  ]),
  RELATIONSHIP: new Set(["relationship.create"]),
} as const;

function genericAttribution(kind: "LEGACY" | "SYSTEM"): ActorAttribution {
  return kind === "SYSTEM"
    ? { principalId: null, kind, label: "System" }
    : { principalId: null, kind, label: "Legacy actor" };
}

const ATTRIBUTION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ATTRIBUTION_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const sensitivityRank: Record<AuditSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function resourceVisibilitySql(
  context: Pick<ResearchServiceContext, "actor" | "workspaceId">,
  input: {
    resourceKind: string;
    id: SQLWrapper;
    sensitivity: SQLWrapper;
  },
): SQL {
  const baseline = sql`${input.sensitivity} IN ('public', 'internal')`;
  if (context.actor.type === "apiKey") return baseline;
  const sensitivityRankSql = (value: SQLWrapper) => sql`CASE ${value}
    WHEN 'public' THEN 0 WHEN 'internal' THEN 1
    WHEN 'confidential' THEN 2 WHEN 'restricted' THEN 3 ELSE 99 END`;
  const now = new Date().toISOString();
  return sql`(
    ${baseline}
    OR EXISTS (
      SELECT 1
      FROM ${resourceGrants}
      INNER JOIN ${accessPolicies}
        ON ${accessPolicies.workspaceId} = ${resourceGrants.workspaceId}
       AND ${accessPolicies.id} = ${resourceGrants.policyId}
      WHERE ${resourceGrants.workspaceId} = ${context.workspaceId}::uuid
        AND ${resourceGrants.resourceKind} = ${input.resourceKind}
        AND ${resourceGrants.resourceId} = ${input.id}
        AND ${resourceGrants.state} = 'active'
        AND ${resourceGrants.deletedAt} IS NULL
        AND (${resourceGrants.validFrom} IS NULL OR ${resourceGrants.validFrom} <= ${now}::timestamptz)
        AND (${resourceGrants.validUntil} IS NULL OR ${resourceGrants.validUntil} >= ${now}::timestamptz)
        AND (${resourceGrants.memberId} = ${context.actor.memberId}
          OR ${resourceGrants.role} = ${context.actor.role})
        AND ${accessPolicies.state} = 'active'
        AND ${accessPolicies.deletedAt} IS NULL
        AND ${input.resourceKind} = ANY(${accessPolicies.resourceKinds})
        AND ${sensitivityRankSql(accessPolicies.sensitivityCeiling)} >=
            ${sensitivityRankSql(input.sensitivity)}
    )
  )`;
}

export async function visibleResourceIds(
  database: Database,
  context: Pick<ResearchServiceContext, "actor" | "workspaceId">,
  input: {
    lockGrants?: boolean;
    resourceKind: string;
    resources: readonly { id: string; sensitivity: AuditSensitivity }[];
  },
): Promise<ReadonlySet<string>> {
  const visible = new Set(
    input.resources
      .filter(
        (resource) =>
          resource.sensitivity === "public" ||
          resource.sensitivity === "internal",
      )
      .map((resource) => resource.id),
  );
  const protectedResources = input.resources.filter(
    (resource) => !visible.has(resource.id),
  );
  if (protectedResources.length === 0 || context.actor.type === "apiKey") {
    return visible;
  }
  const now = new Date();
  const grantQuery = database
    .select({
      resourceId: resourceGrants.resourceId,
      resourceKinds: accessPolicies.resourceKinds,
      sensitivityCeiling: accessPolicies.sensitivityCeiling,
    })
    .from(resourceGrants)
    .innerJoin(
      accessPolicies,
      and(
        eq(accessPolicies.workspaceId, resourceGrants.workspaceId),
        eq(accessPolicies.id, resourceGrants.policyId),
      ),
    )
    .where(
      and(
        eq(resourceGrants.workspaceId, context.workspaceId),
        eq(resourceGrants.resourceKind, input.resourceKind),
        inArray(
          resourceGrants.resourceId,
          protectedResources.map((resource) => resource.id),
        ),
        eq(resourceGrants.state, "active"),
        isNull(resourceGrants.deletedAt),
        or(
          isNull(resourceGrants.validFrom),
          lte(resourceGrants.validFrom, now),
        ),
        or(
          isNull(resourceGrants.validUntil),
          gte(resourceGrants.validUntil, now),
        ),
        or(
          eq(resourceGrants.memberId, context.actor.memberId),
          eq(resourceGrants.role, context.actor.role),
        ),
        eq(accessPolicies.state, "active"),
        isNull(accessPolicies.deletedAt),
      ),
    );
  const grants = input.lockGrants
    ? await grantQuery.for("share")
    : await grantQuery;
  const resourceById = new Map(
    protectedResources.map((resource) => [resource.id, resource]),
  );
  for (const grant of grants) {
    const resource = resourceById.get(grant.resourceId);
    if (
      resource &&
      grant.resourceKinds.includes(input.resourceKind) &&
      sensitivityRank[grant.sensitivityCeiling] >=
        sensitivityRank[resource.sensitivity]
    ) {
      visible.add(resource.id);
    }
  }
  return visible;
}

export async function canAccessResource(
  database: Database,
  context: Pick<ResearchServiceContext, "actor" | "workspaceId">,
  input: {
    id: string;
    lockGrants?: boolean;
    resourceKind: string;
    sensitivity: AuditSensitivity;
  },
): Promise<boolean> {
  const visible = await visibleResourceIds(database, context, {
    resourceKind: input.resourceKind,
    resources: [{ id: input.id, sensitivity: input.sensitivity }],
    lockGrants: input.lockGrants,
  });
  return visible.has(input.id);
}

export function createAuditService(context: ResearchServiceContext) {
  return {
    async write(
      database: AuditableDatabase,
      input: {
        action: string;
        changedFields: readonly string[];
        metadata?: Readonly<Record<string, unknown>>;
        resourceId?: string | null;
        resourceKind: string;
        sensitivity?: AuditSensitivity;
      },
    ): Promise<string> {
      const worker = getTrustedWorkerAuditContext(context);
      if (context.actor.type === "worker" && !worker) {
        throw createGraphQLError(
          "FORBIDDEN",
          "This operation is not permitted.",
        );
      }
      if (worker && !workerAuditActions[worker.operation].has(input.action)) {
        throw createGraphQLError(
          "FORBIDDEN",
          "This operation is not permitted.",
        );
      }
      const id = newId();
      const redactedDiff = redactAuditDiff({
        changedFields: input.changedFields,
        metadata: input.metadata,
        sensitivity: input.sensitivity,
      });
      await database.insert(auditEvents).values({
        id,
        workspaceId: context.workspaceId,
        actorUserId: context.actor.type === "user" ? context.actor.id : null,
        sessionId:
          context.actor.type === "user" ? context.actor.sessionId : null,
        apiKeyId: context.actor.type === "apiKey" ? context.actor.id : null,
        action: worker ? `system.import.${input.action}` : input.action,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId ?? null,
        requestId: context.requestId,
        redactedDiff: worker
          ? {
              ...redactedDiff,
              worker: {
                importId: worker.importId,
                importRowId: worker.importRowId,
                jobId: worker.jobId,
              },
            }
          : redactedDiff,
        outcome: "success",
      });
      return id;
    },
  };
}

function encodeAuditCursor(row: AuditEventRow): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: "audit-occurred-desc",
      t: row.occurredAt.toISOString(),
      i: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeAuditCursor(
  value: string | null | undefined,
): { occurredAt: Date; id: string } | null {
  const parsed = decodeResearchCursor(value, "audit-occurred-desc");
  return parsed
    ? { occurredAt: new Date(parsed.t as string), id: parsed.i as string }
    : null;
}

export function createAuditQueryService(context: ResearchServiceContext) {
  return {
    async resolveAttributions(
      keys: readonly string[],
    ): Promise<readonly ActorAttribution[]> {
      const parsed = keys.map((key) => ({
        key,
        mode: key.slice(0, 1),
        id: key.slice(2),
        valid:
          key === "s:system" ||
          (key.slice(1, 2) === ":" &&
            (key.slice(0, 1) === "p"
              ? ATTRIBUTION_UUID.test(key.slice(2))
              : (key.slice(0, 1) === "u" || key.slice(0, 1) === "k") &&
                ATTRIBUTION_EXTERNAL_ID.test(key.slice(2)))),
      }));
      const principalIds = parsed
        .filter((item) => item.valid && item.mode === "p")
        .map((item) => item.id);
      const userIds = parsed
        .filter((item) => item.valid && item.mode === "u")
        .map((item) => item.id);
      const apiKeyIds = parsed
        .filter((item) => item.valid && item.mode === "k")
        .map((item) => item.id);
      const rows =
        principalIds.length || userIds.length || apiKeyIds.length
          ? await context.database
              .select({
                id: workspacePrincipals.id,
                principalType: workspacePrincipals.principalType,
                userId: workspacePrincipals.userId,
                apiKeyId: workspacePrincipals.apiKeyId,
                userName: users.name,
                apiKeyName: apiKeys.name,
              })
              .from(workspacePrincipals)
              .leftJoin(users, eq(users.id, workspacePrincipals.userId))
              .leftJoin(apiKeys, eq(apiKeys.id, workspacePrincipals.apiKeyId))
              .where(
                and(
                  eq(workspacePrincipals.workspaceId, context.workspaceId),
                  or(
                    principalIds.length
                      ? inArray(workspacePrincipals.id, principalIds)
                      : undefined,
                    userIds.length
                      ? inArray(workspacePrincipals.userId, userIds)
                      : undefined,
                    apiKeyIds.length
                      ? inArray(workspacePrincipals.apiKeyId, apiKeyIds)
                      : undefined,
                  ),
                ),
              )
          : [];
      const byPrincipal = new Map(rows.map((row) => [row.id, row]));
      const byUser = new Map(
        rows.filter((row) => row.userId).map((row) => [row.userId!, row]),
      );
      const byApiKey = new Map(
        rows.filter((row) => row.apiKeyId).map((row) => [row.apiKeyId!, row]),
      );
      return parsed.map((item) => {
        if (item.key === "s:system") return genericAttribution("SYSTEM");
        if (!item.valid) return genericAttribution("LEGACY");
        const row =
          item.mode === "p"
            ? byPrincipal.get(item.id)
            : item.mode === "u"
              ? byUser.get(item.id)
              : item.mode === "k"
                ? byApiKey.get(item.id)
                : undefined;
        if (!row) return genericAttribution("LEGACY");
        if (row.principalType === "system")
          return { principalId: row.id, kind: "SYSTEM", label: "System" };
        if (row.principalType.startsWith("legacy_"))
          return {
            principalId: row.id,
            kind: "LEGACY",
            label: "Legacy actor",
          };
        if (row.principalType === "user")
          return {
            principalId: row.id,
            kind: "USER",
            label: row.userName || "Former user",
          };
        if (row.principalType === "api_key")
          return {
            principalId: row.id,
            kind: "API_KEY",
            label: row.apiKeyName || "Former API key",
          };
        return genericAttribution("LEGACY");
      });
    },
    async list(input: {
      first?: number | null;
      after?: string | null;
      action?: string | null;
      resourceKind?: string | null;
      resourceId?: string | null;
      outcome?: string | null;
      occurredFrom?: string | Date | null;
      occurredUntil?: string | Date | null;
    }) {
      const page = normalizePagination(input);
      const cursor = decodeAuditCursor(page.after);
      const occurredFrom = input.occurredFrom
        ? new Date(input.occurredFrom)
        : null;
      const occurredUntil = input.occurredUntil
        ? new Date(input.occurredUntil)
        : null;
      if (
        (occurredFrom && Number.isNaN(occurredFrom.getTime())) ||
        (occurredUntil && Number.isNaN(occurredUntil.getTime())) ||
        (occurredFrom && occurredUntil && occurredFrom > occurredUntil) ||
        [input.action, input.resourceKind, input.outcome].some(
          (value) => value && (value.length > 200 || value.trim() !== value),
        )
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The audit filter is invalid.",
        );
      const rows = await context.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, context.workspaceId),
            input.action ? eq(auditEvents.action, input.action) : undefined,
            input.resourceKind
              ? eq(auditEvents.resourceKind, input.resourceKind)
              : undefined,
            input.resourceId
              ? eq(auditEvents.resourceId, input.resourceId)
              : undefined,
            input.outcome ? eq(auditEvents.outcome, input.outcome) : undefined,
            occurredFrom
              ? gte(auditEvents.occurredAt, occurredFrom)
              : undefined,
            occurredUntil
              ? lte(auditEvents.occurredAt, occurredUntil)
              : undefined,
            cursor
              ? or(
                  lt(auditEvents.occurredAt, cursor.occurredAt),
                  and(
                    eq(auditEvents.occurredAt, cursor.occurredAt),
                    lt(auditEvents.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          sql`${auditEvents.occurredAt} DESC`,
          sql`${auditEvents.id} DESC`,
        )
        .limit(page.first + 1);
      const nodes = rows.slice(0, page.first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: nodes.length
            ? encodeAuditCursor(nodes[nodes.length - 1]!)
            : null,
        },
      };
    },
  };
}

export type AuditQueryService = ReturnType<typeof createAuditQueryService>;
