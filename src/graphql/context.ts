import { getSessionCookie } from "better-auth/cookies";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { apiKeys, members } from "@/db/schema/auth";
import { workspaces } from "@/db/schema/workspaces";
import {
  verifyOrganizationApiKeyCredential,
  type BetterAuthRuntime,
} from "@/lib/auth/config";
import type { ClientAddressClassification } from "@/lib/network/client-address";
import { canonicalizeHttpOrigin } from "@/lib/security/http-origin.server";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  isWorkspaceRole,
  parseApiKeyPermissionKeys,
  permissionStatements,
  rolePermissionKeys,
  type PermissionKey,
  type PermissionResource,
  type WorkspaceRole,
} from "@/modules/auth/permissions";
import {
  ensureApiKeyPrincipal,
  ensureUserPrincipal,
} from "@/modules/auth/workspaces";
import { createPeopleService } from "@/modules/people/service";
import { createFactsService } from "@/modules/facts/service";
import { createRelationshipsService } from "@/modules/relationships/service";
import { createEvidenceService } from "@/modules/evidence/service";
import { createAuditQueryService } from "@/modules/audit/service";
import { createGraphService } from "@/modules/graph/service";
import {
  createFilesService,
  type FileServiceRuntime,
} from "@/modules/files/service";
import {
  createImportsService,
  type ImportServiceRuntime,
} from "@/modules/imports/service";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
import type { Task12Metrics } from "@/modules/search/metrics";
import {
  createSearchService,
  type SearchRuntime,
} from "@/modules/search/service";
import { createSettingsService } from "@/modules/settings/service";
import type { WorkspaceMemberRuntime } from "@/modules/settings/workspace-members";
import { createLocationsService } from "@/modules/locations/service";
import {
  createAiAnalysisService,
  type AiAnalysisRuntime,
} from "@/modules/ai/service";

import { createGraphQLError } from "./errors";
import {
  createLoaders,
  type GraphQLLoaders,
  type GraphQLServices,
  type SafeWorkspace,
} from "./loaders";
import { MAX_API_KEY_LENGTH } from "./limits";
import {
  OperationLimiter,
  type RequestOperationLimiter,
} from "./operation-limiter";

export type { PermissionKey } from "@/modules/auth/permissions";

export type PermissionActionFor<R extends PermissionResource> =
  (typeof permissionStatements)[R][number];

export type SafeMembership = {
  id: string;
  role: WorkspaceRole;
  userId: string;
};

export type GraphQLActor =
  | {
      type: "user";
      id: string;
      principalId: string;
      sessionId: string;
      memberId: string;
      role: WorkspaceRole;
    }
  | {
      type: "apiKey";
      id: string;
      principalId: string;
      role: null;
    };

export interface GraphQLContext {
  requestId: string;
  actor: GraphQLActor;
  clientAddress: ClientAddressClassification;
  workspaceId: string;
  workspace: SafeWorkspace;
  membership: SafeMembership | null;
  metrics: Task12Metrics;
  operationLimiter: RequestOperationLimiter;
  permissions: ReadonlySet<PermissionKey>;
  loaders: GraphQLLoaders;
  services: GraphQLServices;
}

export type CreateContextInput = {
  auth: BetterAuthRuntime;
  clientAddress: ClientAddressClassification;
  database: Database;
  request: Request;
  requestId: string;
  operationLimiter: OperationLimiter;
  metrics: Task12Metrics;
  searchIndexMaintenance: SearchIndexMaintenance;
  searchRuntime: SearchRuntime;
  trustedOrigins: readonly string[];
  fileRuntime?: FileServiceRuntime;
  importRuntime?: ImportServiceRuntime;
  settingsRuntime?: WorkspaceMemberRuntime;
  aiRuntime: AiAnalysisRuntime;
};

export function parseGraphQLOrigin(value: string): string | null {
  const origin = canonicalizeHttpOrigin(value);
  return value === origin ? origin : null;
}

export function canonicalizeTrustedOrigins(
  values: readonly string[],
): readonly string[] {
  const origins = new Set<string>();
  for (const value of values) {
    const origin = canonicalizeHttpOrigin(value);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

function assertTrustedOrigin(
  request: Request,
  trustedOrigins: readonly string[],
  required: boolean,
): void {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin && !required) return;
  const origin = rawOrigin ? parseGraphQLOrigin(rawOrigin) : null;
  if (!origin || !trustedOrigins.includes(origin)) {
    throw createGraphQLError("FORBIDDEN", "The request origin is not trusted.");
  }
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw createGraphQLError(
      "FORBIDDEN",
      "Cross-site requests are not permitted.",
    );
  }
}

function createServices(input: {
  auth: BetterAuthRuntime;
  database: Database;
  operationLimiter: RequestOperationLimiter;
  searchIndexMaintenance: SearchIndexMaintenance;
  searchRuntime: SearchRuntime;
  context: Omit<GraphQLContext, "loaders" | "operationLimiter" | "services">;
  fileRuntime?: FileServiceRuntime;
  importRuntime?: ImportServiceRuntime;
  settingsRuntime?: WorkspaceMemberRuntime;
  aiRuntime: AiAnalysisRuntime;
}): GraphQLServices {
  return {
    async loadWorkspaces(ids) {
      const requested = [...new Set(ids.filter(Boolean))];
      if (requested.length === 0) return ids.map(() => null);
      const rows = await input.database
        .select({
          id: workspaces.id,
          name: workspaces.name,
          organizationId: workspaces.organizationId,
        })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, input.context.workspaceId),
            inArray(workspaces.id, requested),
            eq(workspaces.state, "active"),
            isNull(workspaces.deletedAt),
          ),
        );
      const byId = new Map(rows.map((workspace) => [workspace.id, workspace]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    people: createPeopleService({
      actor: input.context.actor,
      database: input.database,
      permissions: input.context.permissions,
      requestId: input.context.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.context.workspaceId,
    }),
    facts: createFactsService({
      actor: input.context.actor,
      database: input.database,
      permissions: input.context.permissions,
      requestId: input.context.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.context.workspaceId,
    }),
    relationships: createRelationshipsService({
      actor: input.context.actor,
      database: input.database,
      permissions: input.context.permissions,
      requestId: input.context.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.context.workspaceId,
    }),
    evidence: createEvidenceService({
      actor: input.context.actor,
      database: input.database,
      permissions: input.context.permissions,
      requestId: input.context.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.context.workspaceId,
    }),
    audit: createAuditQueryService({
      actor: input.context.actor,
      database: input.database,
      permissions: input.context.permissions,
      requestId: input.context.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.context.workspaceId,
    }),
    graph: createGraphService({
      actor: input.context.actor,
      cursorHmacKey: input.searchRuntime.cursorHmacKey,
      database: input.database,
      operationLimiter: input.operationLimiter,
      metrics: input.context.metrics,
      permissions: input.context.permissions,
      requestId: input.context.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.context.workspaceId,
    }),
    files: createFilesService(
      {
        actor: input.context.actor,
        database: input.database,
        operationLimiter: input.operationLimiter,
        permissions: input.context.permissions,
        requestId: input.context.requestId,
        searchIndexMaintenance: input.searchIndexMaintenance,
        workspaceId: input.context.workspaceId,
      },
      input.fileRuntime ?? {
        deploymentMode: "docker",
        storageBucket: "unconfigured",
        storageProvider: "s3",
      },
    ),
    imports: createImportsService(
      {
        actor: input.context.actor,
        database: input.database,
        operationLimiter: input.operationLimiter,
        permissions: input.context.permissions,
        requestId: input.context.requestId,
        searchIndexMaintenance: input.searchIndexMaintenance,
        workspaceId: input.context.workspaceId,
      },
      input.importRuntime ?? { encryptionKey: "00".repeat(32) },
    ),
    search: createSearchService(
      {
        ...input.context,
        database: input.database,
        operationLimiter: input.operationLimiter,
        searchIndexMaintenance: input.searchIndexMaintenance,
      },
      input.searchRuntime,
    ),
    settings: createSettingsService({
      actor: input.context.actor,
      auth: input.auth,
      database: input.database,
      organizationId: input.context.workspace.organizationId,
      requestId: input.context.requestId,
      runtime: input.settingsRuntime,
      workspaceId: input.context.workspaceId,
    }),
    locations: createLocationsService(
      {
        actor: input.context.actor,
        database: input.database,
        permissions: input.context.permissions,
        requestId: input.context.requestId,
        searchIndexMaintenance: input.searchIndexMaintenance,
        workspaceId: input.context.workspaceId,
      },
      {
        blindIndexKey: input.searchRuntime.protectedLookupHmacKey,
        cursorHmacKey: input.searchRuntime.cursorHmacKey,
        encryptionKey: input.searchRuntime.encryptionKey ?? "00".repeat(32),
      },
    ),
    ai: createAiAnalysisService(
      {
        actor: input.context.actor,
        database: input.database,
        permissions: input.context.permissions,
        requestId: input.context.requestId,
        searchIndexMaintenance: input.searchIndexMaintenance,
        workspaceId: input.context.workspaceId,
      },
      input.aiRuntime,
    ),
  };
}

export function requirePermission<R extends PermissionResource>(
  context: GraphQLContext,
  resource: R,
  action: PermissionActionFor<R>,
): void {
  if (!context.permissions.has(`${resource}:${action}` as PermissionKey)) {
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
  }
}

function contextWithLoaders(
  base: Omit<GraphQLContext, "loaders" | "operationLimiter" | "services">,
  auth: BetterAuthRuntime,
  database: Database,
  operationLimiter: OperationLimiter,
  searchIndexMaintenance: SearchIndexMaintenance,
  searchRuntime: SearchRuntime,
  aiRuntime: AiAnalysisRuntime,
  fileRuntime?: FileServiceRuntime,
  importRuntime?: ImportServiceRuntime,
  settingsRuntime?: WorkspaceMemberRuntime,
): GraphQLContext {
  const budgetOperation = (operationClass: string) => {
    switch (operationClass) {
      case "search.read":
        return "SEARCH_READ" as const;
      case "saved_query.run":
        return "SAVED_QUERY_RUN" as const;
      case "graph.snapshot":
      case "graph.replay":
        return "GRAPH_SNAPSHOT" as const;
      case "graph.analysis":
      case "ai.analysis.start":
        return "ANALYSIS_RUN" as const;
      case "graph.analysis.export":
        return "ANALYSIS_EXPORT" as const;
      case "graph.analysis.read":
      case "ai.analysis.cancel":
      case "ai.analysis.read":
        return "ANALYSIS_READ" as const;
      default:
        return null;
    }
  };
  const requestOperationLimiter = operationLimiter.forRequest({
    actor: base.actor,
    clientAddress: base.clientAddress,
    requestId: base.requestId,
    workspaceId: base.workspaceId,
    observeBudget: (observation) => {
      const operation = budgetOperation(observation.operationClass);
      if (!operation) return;
      base.metrics.operationBudget({
        dimension:
          observation.dimension === "client_prefix"
            ? "CLIENT"
            : observation.dimension === "workspace"
              ? "WORKSPACE"
              : "ACTOR",
        durationSeconds: observation.durationSeconds,
        operation,
        outcome:
          observation.outcome === "allowed"
            ? "ALLOWED"
            : observation.outcome === "denied"
              ? "DENIED"
              : "UNAVAILABLE",
      });
    },
  });
  const services = createServices({
    auth,
    database,
    context: base,
    operationLimiter: requestOperationLimiter,
    searchIndexMaintenance,
    searchRuntime,
    aiRuntime,
    fileRuntime,
    importRuntime,
    settingsRuntime,
  });
  const loaders = createLoaders({
    services,
    workspaceId: base.workspaceId,
  });
  return {
    ...base,
    loaders,
    operationLimiter: requestOperationLimiter,
    services,
  };
}

async function createSessionContext(
  input: CreateContextInput,
): Promise<GraphQLContext> {
  assertTrustedOrigin(
    input.request,
    input.trustedOrigins,
    input.request.method.toUpperCase() === "POST",
  );
  const session = await input.auth.api.getSession({
    headers: input.request.headers,
    query: {
      disableCookieCache: true,
      disableRefresh: true,
    },
  });
  if (!session) {
    throw createGraphQLError("UNAUTHENTICATED", "The session is invalid.");
  }
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "An active workspace membership is required.",
    );
  }

  const active = await input.database
    .select({
      memberId: members.id,
      role: members.role,
      userId: members.userId,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      organizationId: workspaces.organizationId,
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
    .limit(2);
  const membership = active[0];
  if (active.length !== 1 || !membership || !isWorkspaceRole(membership.role)) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "An active workspace membership is required.",
    );
  }

  const principalId = await ensureUserPrincipal(input.database, {
    memberId: membership.memberId,
    userId: membership.userId,
    workspaceId: membership.workspaceId,
  });
  const workspace: SafeWorkspace = {
    id: membership.workspaceId,
    name: membership.workspaceName,
    organizationId: membership.organizationId,
  };
  return contextWithLoaders(
    {
      actor: {
        type: "user",
        id: membership.userId,
        principalId,
        sessionId: session.session.id,
        memberId: membership.memberId,
        role: membership.role,
      },
      clientAddress: input.clientAddress,
      membership: {
        id: membership.memberId,
        role: membership.role,
        userId: membership.userId,
      },
      permissions: rolePermissionKeys(membership.role),
      metrics: input.metrics,
      requestId: input.requestId,
      workspace,
      workspaceId: workspace.id,
    },
    input.auth,
    input.database,
    input.operationLimiter,
    input.searchIndexMaintenance,
    input.searchRuntime,
    input.aiRuntime,
    input.fileRuntime,
    input.importRuntime,
    input.settingsRuntime,
  );
}

async function createApiKeyContext(
  input: CreateContextInput,
  rawKey: string,
): Promise<GraphQLContext> {
  assertTrustedOrigin(input.request, input.trustedOrigins, false);
  const verification = await verifyOrganizationApiKeyCredential({
    auth: input.auth,
    checkHealth: async () => {
      await input.database.execute(sql`select 1`);
    },
    key: rawKey,
  });
  if (!verification.valid || !verification.key) {
    throw createGraphQLError("UNAUTHENTICATED", "The API key is invalid.");
  }

  const [active] = await input.database
    .select({
      apiKeyId: apiKeys.id,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      organizationId: workspaces.organizationId,
    })
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
        eq(apiKeys.id, verification.key.id),
        eq(apiKeys.configId, "organization"),
        eq(apiKeys.enabled, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!active) {
    throw createGraphQLError("UNAUTHENTICATED", "The API key is invalid.");
  }

  const principalId = await ensureApiKeyPrincipal(input.database, {
    apiKeyId: active.apiKeyId,
    workspaceId: active.workspaceId,
  });
  const workspace: SafeWorkspace = {
    id: active.workspaceId,
    name: active.workspaceName,
    organizationId: active.organizationId,
  };
  return contextWithLoaders(
    {
      actor: {
        type: "apiKey",
        id: active.apiKeyId,
        principalId,
        role: null,
      },
      clientAddress: input.clientAddress,
      membership: null,
      metrics: input.metrics,
      permissions: parseApiKeyPermissionKeys(verification.key.permissions),
      requestId: input.requestId,
      workspace,
      workspaceId: workspace.id,
    },
    input.auth,
    input.database,
    input.operationLimiter,
    input.searchIndexMaintenance,
    input.searchRuntime,
    input.aiRuntime,
    input.fileRuntime,
    input.importRuntime,
    input.settingsRuntime,
  );
}

export async function createContext(
  input: CreateContextInput,
): Promise<GraphQLContext> {
  const sessionCredential = getSessionCookie(input.request);
  const apiKeyHeader = input.request.headers.get("x-api-key");
  const rawApiKey = apiKeyHeader?.trim() ?? "";
  const hasApiKeyHeader = apiKeyHeader !== null;
  const invalidApiKeyHeader =
    hasApiKeyHeader &&
    (!rawApiKey ||
      new TextEncoder().encode(rawApiKey).byteLength > MAX_API_KEY_LENGTH ||
      rawApiKey.includes(","));

  if (
    invalidApiKeyHeader ||
    (sessionCredential && hasApiKeyHeader) ||
    (!sessionCredential && !hasApiKeyHeader)
  ) {
    throw createGraphQLError(
      "UNAUTHENTICATED",
      "Exactly one authentication mode is required.",
    );
  }
  if (sessionCredential) return createSessionContext(input);
  return createApiKeyContext(input, rawApiKey);
}
