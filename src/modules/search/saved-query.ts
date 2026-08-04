import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { queryRuns, savedQueries } from "@/db/schema/search";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import type { RequestOperationLimiter } from "@/graphql/operation-limiter";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import type { Database } from "@/modules/auth/bootstrap-admin";

import {
  canonicalSearchJson,
  hashSavedSearchAst,
  parseSavedSearchAst,
  type SavedSearchAstV1,
} from "./normalization";
import type { Task12Metrics } from "./metrics";
import type { SearchConnection } from "./types";

export type SavedQueryRow = typeof savedQueries.$inferSelect;
export type SavedQueryConnection = {
  nodes: SavedQueryRow[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};

type Context = ResearchServiceContext & {
  metrics: Task12Metrics;
  operationLimiter: RequestOperationLimiter;
};

const RUN_POLICY = {
  capacity: 1_000,
  refillAmount: 1_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const RUN_CLIENT_POLICY = {
  capacity: 2_000,
  refillAmount: 2_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_KEY = /^[0-9a-f]{64}$/iu;

function invalid(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    publicErrorMessage("VALIDATION_FAILED"),
  );
}

function conflict(): never {
  throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
}

function notFound(): never {
  throw createGraphQLError("NOT_FOUND", publicErrorMessage("NOT_FOUND"));
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    Buffer.byteLength(name, "utf8") < 1 ||
    Buffer.byteLength(name, "utf8") > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(name)
  )
    return invalid();
  return name;
}

function normalizeSharing(value: unknown): "PRIVATE" | "WORKSPACE" {
  if (value !== "PRIVATE" && value !== "WORKSPACE") return invalid();
  return value;
}

function signature(secret: string, body: string): string {
  if (!HEX_KEY.test(secret)) return invalid();
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("humans:saved-query-cursor:v1\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function encodeCursor(
  input: { name: string; id: string; principalId: string; workspaceId: string },
  secret: string,
): string {
  const body = Buffer.from(
    canonicalSearchJson({ p: "humans.saved-query.cursor.v1", v: 1, ...input }),
    "utf8",
  ).toString("base64url");
  return `${body}.${signature(secret, body)}`;
}

function decodeCursor(
  value: unknown,
  binding: { principalId: string; workspaceId: string },
  secret: string,
): { name: string; id: string } | null {
  if (value == null) return null;
  try {
    if (
      typeof value !== "string" ||
      value.length > 2_048 ||
      !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u.test(value)
    )
      return invalid();
    const [body = "", supplied = ""] = value.split(".");
    const expected = signature(secret, body);
    if (
      !timingSafeEqual(
        Buffer.from(supplied, "hex"),
        Buffer.from(expected, "hex"),
      )
    )
      return invalid();
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length > 1_024 || bytes.toString("base64url") !== body)
      return invalid();
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      Reflect.ownKeys(parsed).length !== 6 ||
      parsed.p !== "humans.saved-query.cursor.v1" ||
      parsed.v !== 1 ||
      parsed.workspaceId !== binding.workspaceId ||
      parsed.principalId !== binding.principalId ||
      typeof parsed.name !== "string" ||
      typeof parsed.id !== "string" ||
      !UUID.test(parsed.id)
    )
      return invalid();
    return { name: parsed.name, id: parsed.id };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { extensions?: { code?: unknown } }).extensions?.code ===
        "VALIDATION_FAILED"
    )
      throw error;
    return invalid();
  }
}

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

function canRead(context: Context) {
  return context.permissions.has("savedQuery:read");
}

function visibility(context: Context) {
  return context.actor.type === "user"
    ? or(
        eq(savedQueries.ownerPrincipalId, context.actor.principalId),
        eq(savedQueries.sharing, "WORKSPACE"),
      )
    : eq(savedQueries.sharing, "WORKSPACE");
}

function astScopeVisibility(context: Context) {
  const ast = savedQueries.queryAst;
  return (
    and(
      context.permissions.has("person:read")
        ? undefined
        : sql`NOT (${ast}->'kinds' ?| ARRAY['PERSON', 'ADDRESS', 'FACT', 'RELATIONSHIP'])
          AND NOT (${ast}->'filters' ? 'personIds')`,
      context.permissions.has("fact:read")
        ? undefined
        : sql`NOT (${ast}->'kinds' ? 'FACT')
          AND NOT (${ast}->'filters' ?| ARRAY['factDefinitionIds', 'factStates'])`,
      context.permissions.has("relationship:read")
        ? undefined
        : sql`NOT (${ast}->'kinds' ? 'RELATIONSHIP')
          AND NOT (${ast}->'filters' ?| ARRAY['relationshipTypeIds', 'relationshipStates'])`,
      context.permissions.has("evidence:read") &&
        context.permissions.has("source:read")
        ? undefined
        : sql`NOT (${ast}->'kinds' ? 'EVIDENCE')
          AND NOT (${ast}->'filters' ? 'sourceIds')`,
    ) ?? sql`true`
  );
}

async function readable(
  database: Database,
  context: Context,
  id: string,
): Promise<SavedQueryRow | null> {
  if (!UUID.test(id)) return invalid();
  const [row] = await database
    .select()
    .from(savedQueries)
    .where(
      and(
        eq(savedQueries.workspaceId, context.workspaceId),
        eq(savedQueries.id, id),
        isNull(savedQueries.archivedAt),
        visibility(context),
        astScopeVisibility(context),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function createSavedQueryService(
  context: Context,
  runtime: { cursorHmacKey: string },
  executeSearch: (input: unknown) => Promise<SearchConnection>,
) {
  const audit = createAuditService(context);

  return {
    async list(input: {
      first?: number | null;
      after?: string | null;
    }): Promise<SavedQueryConnection> {
      if (!canRead(context))
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      const first = input.first ?? 25;
      if (!Number.isInteger(first) || first < 1 || first > 100)
        return invalid();
      const cursor = decodeCursor(
        input.after,
        {
          principalId: context.actor.principalId,
          workspaceId: context.workspaceId,
        },
        runtime.cursorHmacKey,
      );
      const rows = await context.database
        .select()
        .from(savedQueries)
        .where(
          and(
            eq(savedQueries.workspaceId, context.workspaceId),
            isNull(savedQueries.archivedAt),
            visibility(context),
            astScopeVisibility(context),
            cursor
              ? or(
                  gt(savedQueries.name, cursor.name),
                  and(
                    eq(savedQueries.name, cursor.name),
                    gt(savedQueries.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(savedQueries.name), asc(savedQueries.id))
        .limit(first + 1);
      const nodes = rows.slice(0, first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor:
            rows.length > first && last
              ? encodeCursor(
                  {
                    name: last.name,
                    id: last.id,
                    principalId: context.actor.principalId,
                    workspaceId: context.workspaceId,
                  },
                  runtime.cursorHmacKey,
                )
              : null,
        },
      };
    },

    async read(id: string): Promise<SavedQueryRow | null> {
      if (!canRead(context))
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      return readable(context.database, context, id);
    },

    async create(input: {
      name: unknown;
      sharing: unknown;
      queryAst: unknown;
    }): Promise<SavedQueryRow> {
      if (
        context.actor.type !== "user" ||
        !context.permissions.has("savedQuery:create")
      )
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      const name = normalizeName(input.name);
      const sharing = normalizeSharing(input.sharing);
      const queryAst = parseSavedSearchAst(input.queryAst);
      const queryHash = hashSavedSearchAst(queryAst);
      try {
        return await context.database.transaction(async (transaction) => {
          const database = transaction as Database;
          const [row] = await database
            .insert(savedQueries)
            .values({
              id: newId(),
              workspaceId: context.workspaceId,
              ownerPrincipalId: context.actor.principalId,
              name,
              sharing,
              queryAst,
              astVersion: 1,
              queryHash,
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            })
            .returning();
          if (!row) throw new Error("Saved query insert failed.");
          await audit.write(database, {
            action: "saved_query.create",
            changedFields: ["name", "sharing", "queryAst"],
            resourceKind: "savedQuery",
            resourceId: row.id,
          });
          return row;
        });
      } catch (error) {
        if (postgresCode(error) === "23505") return conflict();
        throw error;
      }
    },

    async update(input: {
      id: unknown;
      expectedVersion: unknown;
      name?: unknown;
      sharing?: unknown;
      queryAst?: unknown;
    }): Promise<SavedQueryRow> {
      if (
        context.actor.type !== "user" ||
        !context.permissions.has("savedQuery:update")
      )
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      if (
        typeof input.id !== "string" ||
        !UUID.test(input.id) ||
        !Number.isInteger(input.expectedVersion) ||
        Number(input.expectedVersion) < 1 ||
        (input.name === undefined &&
          input.sharing === undefined &&
          input.queryAst === undefined)
      )
        return invalid();
      const queryAst =
        input.queryAst === undefined
          ? undefined
          : parseSavedSearchAst(input.queryAst);
      const updates = {
        ...(input.name === undefined
          ? {}
          : { name: normalizeName(input.name) }),
        ...(input.sharing === undefined
          ? {}
          : { sharing: normalizeSharing(input.sharing) }),
        ...(queryAst === undefined
          ? {}
          : {
              queryAst,
              astVersion: 1,
              queryHash: hashSavedSearchAst(queryAst),
            }),
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
        version: sql`${savedQueries.version} + 1`,
      };
      try {
        return await context.database.transaction(async (transaction) => {
          const database = transaction as Database;
          const [row] = await database
            .update(savedQueries)
            .set(updates)
            .where(
              and(
                eq(savedQueries.workspaceId, context.workspaceId),
                eq(savedQueries.id, input.id as string),
                eq(savedQueries.ownerPrincipalId, context.actor.principalId),
                eq(savedQueries.version, Number(input.expectedVersion)),
                isNull(savedQueries.archivedAt),
              ),
            )
            .returning();
          if (!row) return conflict();
          await audit.write(database, {
            action: "saved_query.update",
            changedFields: Object.keys(updates).filter(
              (key) => !["updatedAt", "updatedBy", "version"].includes(key),
            ),
            resourceKind: "savedQuery",
            resourceId: row.id,
          });
          return row;
        });
      } catch (error) {
        if (postgresCode(error) === "23505") return conflict();
        throw error;
      }
    },

    async archive(input: {
      id: unknown;
      expectedVersion: unknown;
    }): Promise<SavedQueryRow> {
      if (
        context.actor.type !== "user" ||
        !context.permissions.has("savedQuery:delete")
      )
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      if (
        typeof input.id !== "string" ||
        !UUID.test(input.id) ||
        !Number.isInteger(input.expectedVersion) ||
        Number(input.expectedVersion) < 1
      )
        return invalid();
      return context.database.transaction(async (transaction) => {
        const database = transaction as Database;
        const now = new Date();
        const [row] = await database
          .update(savedQueries)
          .set({
            archivedAt: now,
            archivedBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
            version: sql`${savedQueries.version} + 1`,
          })
          .where(
            and(
              eq(savedQueries.workspaceId, context.workspaceId),
              eq(savedQueries.id, input.id as string),
              eq(savedQueries.ownerPrincipalId, context.actor.principalId),
              eq(savedQueries.version, Number(input.expectedVersion)),
              isNull(savedQueries.archivedAt),
            ),
          )
          .returning();
        if (!row) return conflict();
        await audit.write(database, {
          action: "saved_query.archive",
          changedFields: ["archivedAt"],
          resourceKind: "savedQuery",
          resourceId: row.id,
        });
        return row;
      });
    },

    async run(id: string): Promise<SearchConnection> {
      if (
        !context.permissions.has("savedQuery:read") ||
        !context.permissions.has("savedQuery:run") ||
        !context.permissions.has("search:run")
      )
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      try {
        await context.operationLimiter.consume({
          operationClass: "saved_query.run",
          cost: 50,
          policy: RUN_POLICY,
          clientPolicy: RUN_CLIENT_POLICY,
        });
      } catch (error) {
        context.metrics.savedQueryRun({ outcome: "DENIED" });
        throw error;
      }
      const saved = await readable(context.database, context, id);
      if (!saved) return notFound();
      const startedAt = new Date();
      const started = performance.now();
      const recordRun = async (
        outcome: "SUCCESS" | "ERROR",
        resultCount: number | null,
      ) => {
        const completedAt = new Date();
        await context.database.transaction(async (transaction) => {
          const database = transaction as Database;
          await database.insert(queryRuns).values({
            id: newId(),
            workspaceId: context.workspaceId,
            savedQueryId: saved.id,
            actorPrincipalId: context.actor.principalId,
            actorKind: context.actor.type === "user" ? "USER" : "API_KEY",
            queryHash: saved.queryHash,
            outcome,
            startedAt,
            completedAt,
            durationMs: Math.max(0, Math.round(performance.now() - started)),
            resultCount,
          });
          await audit.write(database, {
            action:
              outcome === "SUCCESS"
                ? "saved_query.run"
                : "saved_query.run_failed",
            changedFields:
              outcome === "SUCCESS" ? ["outcome", "resultCount"] : ["outcome"],
            metadata: {
              outcome,
              ...(resultCount === null ? {} : { resultCount }),
            },
            resourceKind: "savedQuery",
            resourceId: saved.id,
          });
        });
      };
      let queryAst: SavedSearchAstV1;
      try {
        queryAst = parseSavedSearchAst(saved.queryAst);
        if (hashSavedSearchAst(queryAst) !== saved.queryHash) return conflict();
        const result = await executeSearch({
          version: 1,
          match: queryAst.match,
          kinds: queryAst.kinds,
          filters: queryAst.filters,
          first: queryAst.pageSize,
        });
        await recordRun("SUCCESS", result.nodes.length);
        context.metrics.savedQueryRun({ outcome: "SUCCESS" });
        return result;
      } catch (error) {
        try {
          await recordRun("ERROR", null);
        } catch {
          // Retain the original public failure. Run-record persistence must not
          // turn a provider or validation error into a different disclosure.
        }
        context.metrics.savedQueryRun({ outcome: "ERROR" });
        throw error;
      }
    },
  };
}

export type SavedQueryService = ReturnType<typeof createSavedQueryService>;
