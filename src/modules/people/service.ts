import { createGraphQLError } from "@/graphql/errors";
import { decodeResearchCursor, normalizePagination } from "@/graphql/limits";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  withResearchWriteTransaction as writeTransaction,
} from "@/modules/audit/transactions";
import {
  normalizeHumanText,
  validateUnitDecimal,
  type ValidationIssue,
} from "@/modules/facts/validation";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { mergeDecisions, people, personNames } from "@/db/schema/people";
import { and, eq, isNull, sql } from "drizzle-orm";

import { createPeopleRepository, type PersonRow } from "./repository";

export type MutationOutcome<T> = {
  resource: T | null;
  issues: ValidationIssue[];
  code:
    | "ARCHIVED"
    | "CONFLICT"
    | "NOT_FOUND"
    | "NOT_VISIBLE"
    | "VALIDATION_FAILED"
    | null;
  currentVersion?: number | null;
};

export type PageInfo = { endCursor: string | null; hasNextPage: boolean };
export type Connection<T> = { nodes: T[]; pageInfo: PageInfo };

function invalid<T>(issues: ValidationIssue[]): MutationOutcome<T> {
  return { resource: null, issues, code: "VALIDATION_FAILED" };
}

export function encodeCursor(order: string, sort: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, o: order, s: sort, i: id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  value: string | null,
  order: string,
): { sort: string; id: string } | null {
  const decoded = decodeResearchCursor(value, order);
  return decoded
    ? { sort: decoded.s as string, id: decoded.i as string }
    : null;
}

function sortValue(row: PersonRow): string {
  return row.sortName ?? row.displayName;
}

const RECENT_PEOPLE_CURSOR_ORDER = "dashboard-people-updated-desc";

function encodeRecentCursor(row: Pick<PersonRow, "id" | "updatedAt">): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: RECENT_PEOPLE_CURSOR_ORDER,
      t: row.updatedAt.toISOString(),
      i: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeRecentCursor(
  value: string | null,
): { updatedAt: Date; id: string } | null {
  if (value === null) return null;
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      throw new Error("invalid cursor");
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const updatedAt = new Date(String(decoded.t));
    if (
      Reflect.ownKeys(decoded).length !== 4 ||
      decoded.v !== 1 ||
      decoded.o !== RECENT_PEOPLE_CURSOR_ORDER ||
      typeof decoded.t !== "string" ||
      Number.isNaN(updatedAt.getTime()) ||
      updatedAt.toISOString() !== decoded.t ||
      typeof decoded.i !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        decoded.i,
      )
    )
      throw new Error("invalid cursor");
    return { updatedAt, id: decoded.i.toLowerCase() };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function normalizeDashboardPage(input: {
  first?: number | null;
  after?: string | null;
}): { first: number; after: string | null } {
  const first = input.first ?? 8;
  if (!Number.isInteger(first) || first < 1 || first > 10)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "first must be between 1 and 10.",
    );
  return { first, after: input.after ?? null };
}

function validateVersion(value: number): ValidationIssue[] {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
    ? []
    : [
        {
          path: ["expectedVersion"],
          code: "INVALID_VERSION",
          message: "A positive version is required.",
        },
      ];
}

export function createPeopleService(context: ResearchServiceContext) {
  const repository = createPeopleRepository(context.database);
  const audit = createAuditService(context);
  const visibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: people.id,
    sensitivity: people.sensitivity,
  });

  async function visible(row: PersonRow): Promise<boolean> {
    return canAccessResource(context.database, context, {
      id: row.id,
      resourceKind: "person",
      sensitivity: row.sensitivity,
    });
  }

  return {
    async get(id: string): Promise<PersonRow | null> {
      const row = await repository.getById({
        workspaceId: context.workspaceId,
        id,
        visibility,
      });
      return row;
    },

    async getByIds(
      ids: readonly string[],
    ): Promise<readonly (PersonRow | null)[]> {
      const rows = await repository.getByIds({
        workspaceId: context.workspaceId,
        ids,
        visibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },

    async list(input: {
      first?: number | null;
      after?: string | null;
      name?: string | null;
      namePrefix?: string | null;
      nameContains?: string | null;
      status?: string | null;
      sensitivity?: string | null;
    }): Promise<Connection<PersonRow>> {
      const page = normalizePagination(input);
      const name = input.name
        ? normalizeHumanText(input.name, {
            path: ["filter", "name"],
            min: 1,
            max: 200,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      if (name.issues.length > 0) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The people filter is invalid.",
        );
      }
      const normalizedPrefix = input.namePrefix
        ? normalizeHumanText(input.namePrefix, {
            path: ["filter", "namePrefix"],
            min: 1,
            max: 200,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      const normalizedContains = input.nameContains
        ? normalizeHumanText(input.nameContains, {
            path: ["filter", "nameContains"],
            min: 1,
            max: 200,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      if (normalizedPrefix.issues.length || normalizedContains.issues.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The people filter is invalid.",
        );
      const status = input.status?.toLowerCase() ?? null;
      const sensitivity = input.sensitivity?.toLowerCase() ?? null;
      if (
        (status &&
          ![
            "active",
            "deceased",
            "missing",
            "unknown",
            "archived",
            "merged",
          ].includes(status)) ||
        (sensitivity &&
          !["public", "internal", "confidential", "restricted"].includes(
            sensitivity,
          ))
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The people filter is invalid.",
        );
      const cursor = decodeCursor(page.after, "people-name-asc");
      const rows = await repository.list({
        workspaceId: context.workspaceId,
        cursor,
        limit: Math.min(101, page.first + 1),
        name: name.value,
        namePrefix: normalizedPrefix.value,
        nameContains: normalizedContains.value,
        status: status as PersonRow["status"] | null,
        sensitivity: sensitivity as PersonRow["sensitivity"] | null,
        visibility,
      });
      const nodes = rows.slice(0, page.first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor:
            nodes.length === 0
              ? null
              : encodeCursor(
                  "people-name-asc",
                  sortValue(nodes.at(-1)!),
                  nodes.at(-1)!.id,
                ),
        },
      };
    },

    async listRecent(input: {
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<PersonRow>> {
      const page = normalizeDashboardPage(input);
      const rows = await repository.listRecent({
        workspaceId: context.workspaceId,
        cursor: decodeRecentCursor(page.after),
        limit: page.first + 1,
        visibility,
      });
      const nodes = rows.slice(0, page.first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor:
            nodes.length === 0 ? null : encodeRecentCursor(nodes.at(-1)!),
        },
      };
    },

    async create(input: {
      displayName: string;
      sortName?: string | null;
      preferredName?: string | null;
      biography?: string | null;
      status?: string | null;
      sensitivity?: string | null;
      confidence?: number | null;
      confidenceExplanation?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      const displayName = normalizeHumanText(input.displayName, {
        path: ["displayName"],
        min: 1,
        max: 300,
      });
      const sortName =
        input.sortName == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.sortName, {
              path: ["sortName"],
              min: 1,
              max: 300,
            });
      const preferredName =
        input.preferredName == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.preferredName, {
              path: ["preferredName"],
              min: 1,
              max: 300,
            });
      const biography =
        input.biography == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.biography, {
              path: ["biography"],
              max: 20_000,
              allowLineBreaks: true,
            });
      const confidence = validateUnitDecimal(input.confidence ?? 1, {
        min: 0,
        max: 1,
        path: ["confidence"],
      });
      const issues = [
        ...displayName.issues,
        ...sortName.issues,
        ...preferredName.issues,
        ...biography.issues,
        ...confidence.issues,
      ];
      const statuses = ["active", "deceased", "missing", "unknown", "archived"];
      const sensitivities = [
        "public",
        "internal",
        "confidential",
        "restricted",
      ];
      const status = (input.status ?? "active").toLowerCase();
      const sensitivity = (input.sensitivity ?? "internal").toLowerCase();
      if (!statuses.includes(status))
        issues.push({
          path: ["status"],
          code: "INVALID_ENUM",
          message: "Invalid person status.",
        });
      if (!sensitivities.includes(sensitivity))
        issues.push({
          path: ["sensitivity"],
          code: "INVALID_ENUM",
          message: "Invalid sensitivity.",
        });
      if (issues.length > 0) return invalid(issues);
      const now = new Date();
      const id = newId();
      const row = await writeTransaction(context, async (transaction) => {
        const scopedRepository = createPeopleRepository(
          transaction as unknown as typeof context.database,
        );
        const created = await scopedRepository.create({
          workspaceId: context.workspaceId,
          value: {
            id,
            displayName: displayName.value!,
            sortName: sortName.value,
            preferredName: preferredName.value,
            biography: biography.value,
            status: status as PersonRow["status"],
            sensitivity: sensitivity as PersonRow["sensitivity"],
            confidence: confidence.value ?? "1",
            confidenceExplanation: input.confidenceExplanation?.trim() || null,
            createdAt: now,
            createdBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          },
        });
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.create",
          resourceKind: "person",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: [
            "displayName",
            "sortName",
            "preferredName",
            "biography",
            "status",
            "sensitivity",
            "confidence",
          ],
          metadata: {
            status: created.status,
            sensitivity: created.sensitivity,
            version: created.version,
          },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "person",
            sourceVersion: created.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return created;
      });
      return { resource: row, issues: [], code: null };
    },

    async update(input: {
      id: string;
      expectedVersion: number;
      displayName?: string | null;
      sortName?: string | null;
      preferredName?: string | null;
      biography?: string | null;
      status?: string | null;
      sensitivity?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      const issues = validateVersion(input.expectedVersion);
      if (issues.length > 0) return invalid(issues);
      const current = await repository.getById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current || !(await visible(current))) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      }
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changedFields: string[] = [];
      for (const [key, value, max] of [
        ["displayName", input.displayName, 300],
        ["sortName", input.sortName, 300],
        ["preferredName", input.preferredName, 300],
        ["biography", input.biography, 20_000],
      ] as const) {
        if (value === undefined) continue;
        if (value === null && key !== "displayName") patch[key] = null;
        else {
          const normalized = normalizeHumanText(value, {
            path: [key],
            min: 1,
            max,
            allowLineBreaks: key === "biography",
          });
          if (normalized.issues.length > 0) issues.push(...normalized.issues);
          else patch[key] = normalized.value;
        }
        changedFields.push(key);
      }
      if (input.status !== undefined) {
        const status = input.status?.toLowerCase();
        if (
          !status ||
          !["active", "deceased", "missing", "unknown"].includes(status)
        )
          issues.push({
            path: ["status"],
            code: "INVALID_ENUM",
            message: "Invalid person status.",
          });
        else patch.status = status;
        changedFields.push("status");
      }
      if (input.sensitivity !== undefined) {
        const sensitivity = input.sensitivity?.toLowerCase();
        if (
          !sensitivity ||
          !["public", "internal", "confidential", "restricted"].includes(
            sensitivity,
          )
        )
          issues.push({
            path: ["sensitivity"],
            code: "INVALID_ENUM",
            message: "Invalid sensitivity.",
          });
        else patch.sensitivity = sensitivity;
        changedFields.push("sensitivity");
      }
      if (issues.length > 0) return invalid(issues);
      const updated = await writeTransaction(context, async (transaction) => {
        const scoped = createPeopleRepository(
          transaction as unknown as typeof context.database,
        );
        const row = await scoped.updateIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!row) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.update",
          resourceKind: "person",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields,
          metadata: {
            status: row.status,
            sensitivity: row.sensitivity,
            version: row.version,
          },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: row.id,
            sourceKind: "person",
            sourceVersion: row.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return row;
      });
      if (!updated) {
        const latest = await repository.getById({
          workspaceId: context.workspaceId,
          id: input.id,
        });
        if (!latest || !(await visible(latest)))
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        return {
          resource: null,
          issues: [],
          code: "CONFLICT",
          currentVersion: latest.version,
        };
      }
      return { resource: updated, issues: [], code: null };
    },

    async archive(input: {
      id: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<PersonRow>> {
      const current = await repository.getById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current || !(await visible(current)))
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const now = new Date();
      const archived = await writeTransaction(context, async (transaction) => {
        const scoped = createPeopleRepository(
          transaction as unknown as typeof context.database,
        );
        const row = await scoped.updateIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch: {
            status: "archived",
            deletedAt: now,
            deletedBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          },
        });
        if (!row) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.archive",
          resourceKind: "person",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields: ["status", "deletedAt"],
          metadata: { status: "archived", version: row.version },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "remove",
            sourceId: row.id,
            sourceKind: "person",
            sourceVersion: row.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return row;
      });
      if (!archived)
        return {
          resource: null,
          issues: [],
          code: "CONFLICT",
          currentVersion: current.version,
        };
      return { resource: archived, issues: [], code: null };
    },
    async merge(input: {
      winnerPersonId: string;
      loserPersonId: string;
      reason: string;
    }): Promise<MutationOutcome<PersonRow>> {
      if (!context.permissions.has("person:merge")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Person merging is not permitted.",
        );
      }
      if (
        input.winnerPersonId === input.loserPersonId ||
        input.reason.trim().length < 1
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A distinct winner, loser, and reason are required.",
        );
      }
      const merged = await writeTransaction(context, async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${context.workspaceId}, 19017))`,
        );
        const rows = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.winnerPersonId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const loserRows = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.loserPersonId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const winner = rows[0];
        const loser = loserRows[0];
        if (
          !winner ||
          !loser ||
          winner.status === "merged" ||
          loser.status === "merged"
        ) {
          throw createGraphQLError(
            "NOT_FOUND",
            "The people selected for merge were not found.",
          );
        }
        const decisionId = newId();
        await transaction.insert(mergeDecisions).values({
          id: decisionId,
          workspaceId: context.workspaceId,
          winnerPersonId: winner.id,
          loserPersonId: loser.id,
          reason: input.reason.trim().slice(0, 2048),
          fieldChoices: {},
          reversibleSnapshot: {
            loser: {
              status: loser.status,
              mergedIntoPersonId: loser.mergedIntoPersonId,
              version: loser.version,
            },
          },
          decidedBy: context.actor.principalId,
          createdBy: context.actor.principalId,
          updatedBy: context.actor.principalId,
        });
        const [updated] = await transaction
          .update(people)
          .set({
            status: "merged",
            mergedIntoPersonId: winner.id,
            version: sql`${people.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          })
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, loser.id),
              eq(people.version, loser.version),
            ),
          )
          .returning();
        if (!updated) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.merge",
          resourceKind: "person",
          resourceId: winner.id,
          sensitivity: winner.sensitivity,
          changedFields: ["mergedIntoPersonId", "status"],
          metadata: { loserPersonId: loser.id, mergeDecisionId: decisionId },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: winner.id,
            sourceKind: "person",
            sourceVersion: winner.version,
            workspaceId: context.workspaceId,
          },
          {
            action: "remove",
            sourceId: loser.id,
            sourceKind: "person",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return winner;
      });
      if (!merged) return { resource: null, issues: [], code: "CONFLICT" };
      return { resource: merged, issues: [], code: null };
    },
    async unmerge(input: {
      loserPersonId: string;
      expectedVersion: number;
    }): Promise<MutationOutcome<PersonRow>> {
      if (!context.permissions.has("person:merge")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Person merging is not permitted.",
        );
      }
      const restored = await writeTransaction(context, async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${context.workspaceId}, 19017))`,
        );
        const [loser] = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.loserPersonId),
              eq(people.status, "merged"),
              eq(people.version, input.expectedVersion),
            ),
          )
          .limit(1)
          .for("update");
        if (!loser) return null;
        const [decision] = await transaction
          .select()
          .from(mergeDecisions)
          .where(
            and(
              eq(mergeDecisions.workspaceId, context.workspaceId),
              eq(mergeDecisions.loserPersonId, loser.id),
              isNull(mergeDecisions.deletedAt),
            ),
          )
          .orderBy(sql`${mergeDecisions.decidedAt} desc`)
          .limit(1)
          .for("update");
        if (!decision) return null;
        const snapshot = decision.reversibleSnapshot as {
          loser?: { status?: string; version?: number };
        };
        const status =
          snapshot.loser?.status &&
          ["active", "deceased", "missing", "unknown", "archived"].includes(
            snapshot.loser.status,
          )
            ? snapshot.loser.status
            : "unknown";
        const [updated] = await transaction
          .update(people)
          .set({
            status: status as PersonRow["status"],
            mergedIntoPersonId: null,
            version: sql`${people.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          })
          .where(
            and(
              eq(people.id, loser.id),
              eq(people.workspaceId, context.workspaceId),
              eq(people.version, loser.version),
            ),
          )
          .returning();
        if (!updated) return null;
        await transaction
          .update(mergeDecisions)
          .set({
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
            version: sql`${mergeDecisions.version} + 1`,
          })
          .where(eq(mergeDecisions.id, decision.id));
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.unmerge",
          resourceKind: "person",
          resourceId: loser.id,
          sensitivity: loser.sensitivity,
          changedFields: ["mergedIntoPersonId", "status"],
          metadata: { mergeDecisionId: decision.id },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: loser.id,
            sourceKind: "person",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      if (!restored) return { resource: null, issues: [], code: "CONFLICT" };
      return { resource: restored, issues: [], code: null };
    },
    async selectPresentation(input: {
      personId: string;
      expectedVersion: number;
      primaryNameId?: string | null;
      primaryPhotoFileId?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      if (!context.permissions.has("person:update")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Person presentation updates are not permitted.",
        );
      }
      const result = await writeTransaction(context, async (transaction) => {
        const [current] = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.personId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) return null;
        if (input.primaryNameId !== undefined && input.primaryNameId !== null) {
          const [name] = await transaction
            .select({ id: personNames.id })
            .from(personNames)
            .where(
              and(
                eq(personNames.workspaceId, context.workspaceId),
                eq(personNames.personId, input.personId),
                eq(personNames.id, input.primaryNameId),
                isNull(personNames.deletedAt),
              ),
            )
            .limit(1)
            .for("share");
          if (!name)
            throw createGraphQLError(
              "VALIDATION_FAILED",
              "The selected primary name does not belong to this person.",
            );
        }
        if (
          input.primaryPhotoFileId !== undefined &&
          input.primaryPhotoFileId !== null
        ) {
          const [photo] = await transaction
            .select({ id: files.id })
            .from(files)
            .where(
              and(
                eq(files.workspaceId, context.workspaceId),
                eq(files.id, input.primaryPhotoFileId),
                eq(files.quarantineState, "available"),
                isNull(files.deletedAt),
              ),
            )
            .limit(1)
            .for("share");
          if (!photo)
            throw createGraphQLError(
              "VALIDATION_FAILED",
              "The selected primary photo is not available.",
            );
        }
        const [updated] = await transaction
          .update(people)
          .set({
            ...(input.primaryNameId === undefined
              ? {}
              : { primaryNameId: input.primaryNameId }),
            ...(input.primaryPhotoFileId === undefined
              ? {}
              : { primaryPhotoFileId: input.primaryPhotoFileId }),
            version: sql`${people.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          })
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.personId),
              eq(people.version, input.expectedVersion),
              isNull(people.deletedAt),
            ),
          )
          .returning();
        if (!updated) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.presentation.select",
          resourceKind: "person",
          resourceId: updated.id,
          sensitivity: updated.sensitivity,
          changedFields: ["primaryNameId", "primaryPhotoFileId"],
          metadata: { version: updated.version },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "person",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      if (!result) return { resource: null, issues: [], code: "CONFLICT" };
      return { resource: result, issues: [], code: null };
    },
  };
}

export type PeopleService = ReturnType<typeof createPeopleService>;
