import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { people } from "@/db/schema/people";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type RelationshipTypeRow = typeof relationshipTypes.$inferSelect;
export type RelationshipRow = typeof relationships.$inferSelect;

export function createRelationshipsRepository(database: Database) {
  return {
    async getType(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(relationshipTypes)
        .where(
          and(
            eq(relationshipTypes.workspaceId, input.workspaceId),
            eq(relationshipTypes.id, input.id),
            isNull(relationshipTypes.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getTypeForUpdate(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(relationshipTypes)
        .where(
          and(
            eq(relationshipTypes.workspaceId, input.workspaceId),
            eq(relationshipTypes.id, input.id),
            isNull(relationshipTypes.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getTypesByIds(input: {
      workspaceId: string;
      ids: readonly string[];
    }) {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(relationshipTypes)
        .where(
          and(
            eq(relationshipTypes.workspaceId, input.workspaceId),
            inArray(relationshipTypes.id, [...input.ids]),
            isNull(relationshipTypes.deletedAt),
          ),
        );
    },
    async listTypes(input: {
      workspaceId: string;
      limit: number;
      cursor?: { namespace: string; key: string; id: string } | null;
      namespace?: string | null;
      key?: string | null;
      state?: RelationshipTypeRow["state"] | null;
      directed?: boolean | null;
      allowsSelf?: boolean | null;
      allowedMultiplicity?: string | null;
    }) {
      return database
        .select()
        .from(relationshipTypes)
        .where(
          and(
            eq(relationshipTypes.workspaceId, input.workspaceId),
            isNull(relationshipTypes.deletedAt),
            input.namespace
              ? eq(relationshipTypes.namespace, input.namespace)
              : undefined,
            input.key ? eq(relationshipTypes.key, input.key) : undefined,
            input.state ? eq(relationshipTypes.state, input.state) : undefined,
            input.directed == null
              ? undefined
              : eq(relationshipTypes.directed, input.directed),
            input.allowsSelf == null
              ? undefined
              : eq(relationshipTypes.allowsSelf, input.allowsSelf),
            input.allowedMultiplicity
              ? eq(
                  relationshipTypes.allowedMultiplicity,
                  input.allowedMultiplicity,
                )
              : undefined,
            input.cursor
              ? or(
                  sql`${relationshipTypes.namespace} > ${input.cursor.namespace}`,
                  and(
                    eq(relationshipTypes.namespace, input.cursor.namespace),
                    sql`${relationshipTypes.key} > ${input.cursor.key}`,
                  ),
                  and(
                    eq(relationshipTypes.namespace, input.cursor.namespace),
                    eq(relationshipTypes.key, input.cursor.key),
                    sql`${relationshipTypes.id} > ${input.cursor.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          asc(relationshipTypes.namespace),
          asc(relationshipTypes.key),
          asc(relationshipTypes.id),
        )
        .limit(input.limit);
    },
    async createType(input: {
      workspaceId: string;
      value: Omit<typeof relationshipTypes.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(relationshipTypes)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row)
        throw new Error("Relationship type insert did not return a row");
      return row;
    },
    async updateTypeIfVersion(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof relationshipTypes.$inferInsert>;
    }) {
      const [row] = await database
        .update(relationshipTypes)
        .set({ ...input.patch, version: sql`${relationshipTypes.version} + 1` })
        .where(
          and(
            eq(relationshipTypes.workspaceId, input.workspaceId),
            eq(relationshipTypes.id, input.id),
            eq(relationshipTypes.version, input.expectedVersion),
            isNull(relationshipTypes.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async get(input: { workspaceId: string; id: string; visibility?: SQL }) {
      const [row] = await database
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, input.workspaceId),
            eq(relationships.id, input.id),
            isNull(relationships.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getForUpdate(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, input.workspaceId),
            eq(relationships.id, input.id),
            isNull(relationships.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getByIds(input: {
      workspaceId: string;
      ids: readonly string[];
      visibility?: SQL;
    }) {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, input.workspaceId),
            inArray(relationships.id, [...input.ids]),
            isNull(relationships.deletedAt),
            input.visibility,
          ),
        );
    },
    async getPeopleForUpdate(input: {
      workspaceId: string;
      ids: readonly string[];
    }) {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            inArray(people.id, [...input.ids]),
            isNull(people.deletedAt),
          ),
        )
        .orderBy(asc(people.id))
        .for("update");
    },
    async list(input: {
      workspaceId: string;
      limit: number;
      personId?: string | null;
      relationshipTypeId?: string | null;
      state?: RelationshipRow["state"] | null;
      sensitivity?: RelationshipRow["sensitivity"] | null;
      activeAt?: Date | null;
      cursor?: { createdAt: Date; id: string } | null;
      visibility?: SQL;
    }) {
      return database
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, input.workspaceId),
            isNull(relationships.deletedAt),
            input.visibility,
            input.personId
              ? or(
                  eq(relationships.sourcePersonId, input.personId),
                  eq(relationships.targetPersonId, input.personId),
                )
              : undefined,
            input.relationshipTypeId
              ? eq(relationships.relationshipTypeId, input.relationshipTypeId)
              : undefined,
            input.state ? eq(relationships.state, input.state) : undefined,
            input.sensitivity
              ? eq(relationships.sensitivity, input.sensitivity)
              : undefined,
            input.activeAt
              ? and(
                  or(
                    isNull(relationships.validFrom),
                    lte(relationships.validFrom, input.activeAt),
                  ),
                  or(
                    isNull(relationships.validUntil),
                    gte(relationships.validUntil, input.activeAt),
                  ),
                )
              : undefined,
            input.cursor
              ? or(
                  lt(relationships.createdAt, input.cursor.createdAt),
                  and(
                    eq(relationships.createdAt, input.cursor.createdAt),
                    sql`${relationships.id} < ${input.cursor.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(relationships.createdAt), desc(relationships.id))
        .limit(input.limit);
    },
    async listForPeople(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        personId: string;
        cursor?: { createdAt: Date; id: string } | null;
      }[];
      limitPerPerson: number;
      visibility?: SQL;
      personVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.personId}::uuid, ${page.cursor?.createdAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_relationship_people"("page_key", "person_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_relationship_people"."page_key"`;
      const requestedPersonId = sql<string>`"requested_relationship_people"."person_id"`;
      const cursorAt = sql<Date | null>`"requested_relationship_people"."cursor_at"`;
      const cursorId = sql<
        string | null
      >`"requested_relationship_people"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          parentPersonId: requestedPersonId.as("parent_person_id"),
          ...getTableColumns(relationships),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${relationships.createdAt} desc, ${relationships.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          relationships,
          and(
            eq(relationships.workspaceId, input.workspaceId),
            isNull(relationships.deletedAt),
            input.visibility,
            or(
              eq(relationships.sourcePersonId, requestedPersonId),
              eq(relationships.targetPersonId, requestedPersonId),
            ),
            sql`(${cursorAt} IS NULL OR ${relationships.createdAt} < ${cursorAt} OR (${relationships.createdAt} = ${cursorAt} AND ${relationships.id} < ${cursorId}))`,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, input.workspaceId),
            sql`${people.id} = ${requestedPersonId}`,
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .as("ranked_relationships_by_person");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerPerson))
        .orderBy(asc(ranked.pageKey), desc(ranked.createdAt), desc(ranked.id));
    },
    async create(input: {
      workspaceId: string;
      value: Omit<typeof relationships.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(relationships)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Relationship insert did not return a row");
      return row;
    },
    async updateIfVersion(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof relationships.$inferInsert>;
    }) {
      const [row] = await database
        .update(relationships)
        .set({ ...input.patch, version: sql`${relationships.version} + 1` })
        .where(
          and(
            eq(relationships.workspaceId, input.workspaceId),
            eq(relationships.id, input.id),
            eq(relationships.version, input.expectedVersion),
            isNull(relationships.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async multiplicityConflicts(input: {
      workspaceId: string;
      typeId: string;
      sourceId: string;
      targetId: string;
      multiplicity: string;
      directed: boolean;
    }) {
      if (input.multiplicity === "many_to_many") return false;
      const rows = await database
        .select({
          source: relationships.sourcePersonId,
          target: relationships.targetPersonId,
        })
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, input.workspaceId),
            eq(relationships.relationshipTypeId, input.typeId),
            isNull(relationships.deletedAt),
          ),
        );
      if (!input.directed)
        return rows.some(
          (row) =>
            [row.source, row.target].includes(input.sourceId) ||
            [row.source, row.target].includes(input.targetId),
        );
      return rows.some(
        (row) =>
          (input.multiplicity === "one_to_one" &&
            (row.source === input.sourceId || row.target === input.targetId)) ||
          (input.multiplicity === "one_to_many" &&
            row.target === input.targetId) ||
          (input.multiplicity === "many_to_one" &&
            row.source === input.sourceId),
      );
    },
  };
}
