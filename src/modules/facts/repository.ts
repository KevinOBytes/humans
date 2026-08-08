import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  factDefinitions,
  factRelationships,
  factRevisions,
  facts,
  personFieldSelections,
} from "@/db/schema/facts";
import { files } from "@/db/schema/files";
import { places } from "@/db/schema/locations";
import { people } from "@/db/schema/people";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type FactDefinitionRow = typeof factDefinitions.$inferSelect;
export type FactRow = typeof facts.$inferSelect;
export type FactRevisionRow = typeof factRevisions.$inferSelect;
export type PersonFieldSelectionRow = typeof personFieldSelections.$inferSelect;
export type FactRelationshipRow = typeof factRelationships.$inferSelect;

export const sourceFactForRelationship = alias(
  facts,
  "source_fact_for_relationship",
);
export const targetFactForRelationship = alias(
  facts,
  "target_fact_for_relationship",
);

export function createFactsRepository(database: Database) {
  return {
    async getDefinition(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(factDefinitions)
        .where(
          and(
            eq(factDefinitions.workspaceId, input.workspaceId),
            eq(factDefinitions.id, input.id),
            isNull(factDefinitions.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getDefinitionForUpdate(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(factDefinitions)
        .where(
          and(
            eq(factDefinitions.workspaceId, input.workspaceId),
            eq(factDefinitions.id, input.id),
            isNull(factDefinitions.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getDefinitionsByIds(input: {
      workspaceId: string;
      ids: readonly string[];
    }) {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(factDefinitions)
        .where(
          and(
            eq(factDefinitions.workspaceId, input.workspaceId),
            inArray(factDefinitions.id, [...input.ids]),
            isNull(factDefinitions.deletedAt),
          ),
        );
    },
    async listDefinitions(input: {
      workspaceId: string;
      limit: number;
      cursor?: { namespace: string; key: string; id: string } | null;
      namespace?: string | null;
      fieldKey?: string | null;
      category?: string | null;
      allowedValueType?: FactDefinitionRow["allowedValueType"] | null;
      cardinality?: FactDefinitionRow["cardinality"] | null;
      searchable?: boolean | null;
      filterable?: boolean | null;
      graphable?: boolean | null;
      defaultSensitivity?: FactDefinitionRow["defaultSensitivity"] | null;
      state?: FactDefinitionRow["state"] | null;
    }) {
      return database
        .select()
        .from(factDefinitions)
        .where(
          and(
            eq(factDefinitions.workspaceId, input.workspaceId),
            isNull(factDefinitions.deletedAt),
            input.namespace
              ? eq(factDefinitions.namespace, input.namespace)
              : undefined,
            input.fieldKey
              ? eq(factDefinitions.fieldKey, input.fieldKey)
              : undefined,
            input.category
              ? eq(factDefinitions.category, input.category)
              : undefined,
            input.allowedValueType
              ? eq(factDefinitions.allowedValueType, input.allowedValueType)
              : undefined,
            input.cardinality
              ? eq(factDefinitions.cardinality, input.cardinality)
              : undefined,
            input.searchable == null
              ? undefined
              : eq(factDefinitions.searchable, input.searchable),
            input.filterable == null
              ? undefined
              : eq(factDefinitions.filterable, input.filterable),
            input.graphable == null
              ? undefined
              : eq(factDefinitions.graphable, input.graphable),
            input.defaultSensitivity
              ? eq(factDefinitions.defaultSensitivity, input.defaultSensitivity)
              : undefined,
            input.state ? eq(factDefinitions.state, input.state) : undefined,
            input.cursor
              ? sql`(${factDefinitions.namespace}, ${factDefinitions.fieldKey}, ${factDefinitions.id}) > (${input.cursor.namespace}, ${input.cursor.key}, ${input.cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(
          asc(factDefinitions.namespace),
          asc(factDefinitions.fieldKey),
          asc(factDefinitions.id),
        )
        .limit(input.limit);
    },
    async createDefinition(input: {
      workspaceId: string;
      value: Omit<typeof factDefinitions.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(factDefinitions)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Fact definition insert did not return a row");
      return row;
    },
    async updateDefinitionIfVersion(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof factDefinitions.$inferInsert>;
    }) {
      const [row] = await database
        .update(factDefinitions)
        .set({ ...input.patch, version: sql`${factDefinitions.version} + 1` })
        .where(
          and(
            eq(factDefinitions.workspaceId, input.workspaceId),
            eq(factDefinitions.id, input.id),
            eq(factDefinitions.version, input.expectedVersion),
            isNull(factDefinitions.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async getFact(input: {
      workspaceId: string;
      id: string;
      visibility?: SQL;
    }) {
      const [row] = await database
        .select()
        .from(facts)
        .where(
          and(
            eq(facts.workspaceId, input.workspaceId),
            eq(facts.id, input.id),
            isNull(facts.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getFactForUpdate(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(facts)
        .where(
          and(
            eq(facts.workspaceId, input.workspaceId),
            eq(facts.id, input.id),
            isNull(facts.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getFactsByIds(input: {
      workspaceId: string;
      ids: readonly string[];
      visibility?: SQL;
    }) {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(facts)
        .where(
          and(
            eq(facts.workspaceId, input.workspaceId),
            inArray(facts.id, [...input.ids]),
            isNull(facts.deletedAt),
            input.visibility,
          ),
        );
    },
    async listFacts(input: {
      workspaceId: string;
      limit: number;
      cursor?: { assertedAt: Date; id: string } | null;
      personId?: string | null;
      definitionId?: string | null;
      namespace?: string | null;
      fieldKey?: string | null;
      state?: FactRow["state"] | null;
      reviewState?: FactRow["reviewState"] | null;
      sensitivity?: FactRow["sensitivity"] | null;
      visibility?: SQL;
    }) {
      return database
        .select()
        .from(facts)
        .where(
          and(
            eq(facts.workspaceId, input.workspaceId),
            isNull(facts.deletedAt),
            input.visibility,
            input.personId ? eq(facts.personId, input.personId) : undefined,
            input.definitionId
              ? eq(facts.factDefinitionId, input.definitionId)
              : undefined,
            input.namespace ? eq(facts.namespace, input.namespace) : undefined,
            input.fieldKey ? eq(facts.fieldKey, input.fieldKey) : undefined,
            input.state ? eq(facts.state, input.state) : undefined,
            input.reviewState
              ? eq(facts.reviewState, input.reviewState)
              : undefined,
            input.sensitivity
              ? eq(facts.sensitivity, input.sensitivity)
              : undefined,
            input.cursor
              ? or(
                  lt(facts.assertedAt, input.cursor.assertedAt),
                  and(
                    eq(facts.assertedAt, input.cursor.assertedAt),
                    sql`${facts.id} < ${input.cursor.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(facts.assertedAt), desc(facts.id))
        .limit(input.limit);
    },
    async listFactsForPeople(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        personId: string;
        cursor?: { assertedAt: Date; id: string } | null;
      }[];
      limitPerPerson: number;
      visibility?: SQL;
      personVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.personId}::uuid, ${page.cursor?.assertedAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_fact_pages"("page_key", "person_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_fact_pages"."page_key"`;
      const personId = sql<string>`"requested_fact_pages"."person_id"`;
      const cursorAt = sql<Date | null>`"requested_fact_pages"."cursor_at"`;
      const cursorId = sql<string | null>`"requested_fact_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(facts),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${facts.assertedAt} desc, ${facts.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          facts,
          and(
            eq(facts.workspaceId, input.workspaceId),
            sql`${facts.personId} = ${personId}`,
            isNull(facts.deletedAt),
            input.visibility,
            sql`(${cursorAt} IS NULL OR ${facts.assertedAt} < ${cursorAt} OR (${facts.assertedAt} = ${cursorAt} AND ${facts.id} < ${cursorId}))`,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, input.workspaceId),
            sql`${people.id} = ${personId}`,
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .as("ranked_fact_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerPerson))
        .orderBy(asc(ranked.pageKey), desc(ranked.assertedAt), desc(ranked.id));
    },
    async createFact(input: {
      workspaceId: string;
      value: Omit<typeof facts.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(facts)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Fact insert did not return a row");
      return row;
    },
    async updateFactIfVersion(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof facts.$inferInsert>;
    }) {
      const [row] = await database
        .update(facts)
        .set({ ...input.patch, version: sql`${facts.version} + 1` })
        .where(
          and(
            eq(facts.workspaceId, input.workspaceId),
            eq(facts.id, input.id),
            eq(facts.version, input.expectedVersion),
            isNull(facts.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async createRevision(input: {
      workspaceId: string;
      value: Omit<typeof factRevisions.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(factRevisions)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Fact revision insert did not return a row");
      return row;
    },
    async listRevisions(input: {
      workspaceId: string;
      factId: string;
      limit: number;
      cursor?: { revision: number; id: string } | null;
    }) {
      return database
        .select()
        .from(factRevisions)
        .where(
          and(
            eq(factRevisions.workspaceId, input.workspaceId),
            eq(factRevisions.factId, input.factId),
            input.cursor
              ? or(
                  sql`${factRevisions.revision} < ${input.cursor.revision}`,
                  and(
                    eq(factRevisions.revision, input.cursor.revision),
                    sql`${factRevisions.id} < ${input.cursor.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(factRevisions.revision), desc(factRevisions.id))
        .limit(input.limit);
    },
    async listRevisionsForFacts(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        factId: string;
        cursor?: { revision: number; id: string } | null;
      }[];
      limitPerFact: number;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.factId}::uuid, ${page.cursor?.revision ?? null}::integer, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_revision_pages"("page_key", "fact_id", "cursor_revision", "cursor_id")`;
      const pageKey = sql<number>`"requested_revision_pages"."page_key"`;
      const factId = sql<string>`"requested_revision_pages"."fact_id"`;
      const cursorRevision = sql<
        number | null
      >`"requested_revision_pages"."cursor_revision"`;
      const cursorId = sql<
        string | null
      >`"requested_revision_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(factRevisions),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${factRevisions.revision} desc, ${factRevisions.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          factRevisions,
          and(
            eq(factRevisions.workspaceId, input.workspaceId),
            sql`${factRevisions.factId} = ${factId}`,
            sql`(${cursorRevision} IS NULL OR ${factRevisions.revision} < ${cursorRevision} OR (${factRevisions.revision} = ${cursorRevision} AND ${factRevisions.id} < ${cursorId}))`,
          ),
        )
        .as("ranked_revision_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerFact))
        .orderBy(asc(ranked.pageKey), desc(ranked.revision), desc(ranked.id));
    },
    async getSelection(input: {
      workspaceId: string;
      personId: string;
      namespace: string;
      fieldKey: string;
    }) {
      const [row] = await database
        .select()
        .from(personFieldSelections)
        .where(
          and(
            eq(personFieldSelections.workspaceId, input.workspaceId),
            eq(personFieldSelections.personId, input.personId),
            eq(personFieldSelections.namespace, input.namespace),
            eq(personFieldSelections.fieldKey, input.fieldKey),
            isNull(personFieldSelections.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async listSelectionsForPeople(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        personId: string;
        cursor?: { namespace: string; fieldKey: string; id: string } | null;
      }[];
      limitPerPerson: number;
      factVisibility: SQL;
      personVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.personId}::uuid, ${page.cursor?.namespace ?? null}::text, ${page.cursor?.fieldKey ?? null}::text, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_selection_pages"("page_key", "person_id", "cursor_namespace", "cursor_field_key", "cursor_id")`;
      const pageKey = sql<number>`"requested_selection_pages"."page_key"`;
      const personId = sql<string>`"requested_selection_pages"."person_id"`;
      const cursorNamespace = sql<
        string | null
      >`"requested_selection_pages"."cursor_namespace"`;
      const cursorFieldKey = sql<
        string | null
      >`"requested_selection_pages"."cursor_field_key"`;
      const cursorId = sql<
        string | null
      >`"requested_selection_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(personFieldSelections),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${personFieldSelections.namespace} asc, ${personFieldSelections.fieldKey} asc, ${personFieldSelections.id} asc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          personFieldSelections,
          and(
            eq(personFieldSelections.workspaceId, input.workspaceId),
            sql`${personFieldSelections.personId} = ${personId}`,
            isNull(personFieldSelections.deletedAt),
            sql`(${cursorNamespace} IS NULL OR (${personFieldSelections.namespace}, ${personFieldSelections.fieldKey}, ${personFieldSelections.id}) > (${cursorNamespace}, ${cursorFieldKey}, ${cursorId}))`,
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, input.workspaceId),
            sql`${people.id} = ${personId}`,
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .innerJoin(
          facts,
          and(
            eq(facts.workspaceId, input.workspaceId),
            eq(facts.personId, personFieldSelections.personId),
            eq(facts.namespace, personFieldSelections.namespace),
            eq(facts.fieldKey, personFieldSelections.fieldKey),
            eq(facts.id, personFieldSelections.factId),
            isNull(facts.deletedAt),
            input.factVisibility,
          ),
        )
        .as("ranked_selection_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerPerson))
        .orderBy(
          asc(ranked.pageKey),
          asc(ranked.namespace),
          asc(ranked.fieldKey),
          asc(ranked.id),
        );
    },
    async createSelection(input: {
      workspaceId: string;
      value: Omit<typeof personFieldSelections.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(personFieldSelections)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Selection insert did not return a row");
      return row;
    },
    async updateSelectionIfVersion(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof personFieldSelections.$inferInsert>;
    }) {
      const [row] = await database
        .update(personFieldSelections)
        .set({
          ...input.patch,
          version: sql`${personFieldSelections.version} + 1`,
        })
        .where(
          and(
            eq(personFieldSelections.workspaceId, input.workspaceId),
            eq(personFieldSelections.id, input.id),
            eq(personFieldSelections.version, input.expectedVersion),
            isNull(personFieldSelections.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async createFactRelationship(input: {
      workspaceId: string;
      value: Omit<typeof factRelationships.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(factRelationships)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row)
        throw new Error("Fact relationship insert did not return a row");
      return row;
    },
    async getFactRelationship(input: {
      workspaceId: string;
      id: string;
      includeDeleted?: boolean;
    }) {
      const [row] = await database
        .select()
        .from(factRelationships)
        .where(
          and(
            eq(factRelationships.workspaceId, input.workspaceId),
            eq(factRelationships.id, input.id),
            ...(input.includeDeleted
              ? []
              : [isNull(factRelationships.deletedAt)]),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async listFactRelationships(input: {
      workspaceId: string;
      factId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      sourceVisibility?: SQL;
      targetVisibility?: SQL;
    }) {
      return database
        .select(getTableColumns(factRelationships))
        .from(factRelationships)
        .innerJoin(
          sourceFactForRelationship,
          and(
            eq(sourceFactForRelationship.id, factRelationships.sourceFactId),
            eq(sourceFactForRelationship.workspaceId, input.workspaceId),
            isNull(sourceFactForRelationship.deletedAt),
          ),
        )
        .innerJoin(
          targetFactForRelationship,
          and(
            eq(targetFactForRelationship.id, factRelationships.targetFactId),
            eq(targetFactForRelationship.workspaceId, input.workspaceId),
            isNull(targetFactForRelationship.deletedAt),
          ),
        )
        .where(
          and(
            eq(factRelationships.workspaceId, input.workspaceId),
            or(
              eq(factRelationships.sourceFactId, input.factId),
              eq(factRelationships.targetFactId, input.factId),
            ),
            isNull(factRelationships.deletedAt),
            input.sourceVisibility,
            input.targetVisibility,
            input.cursor
              ? or(
                  sql`${factRelationships.createdAt} < ${input.cursor.createdAt}`,
                  and(
                    eq(factRelationships.createdAt, input.cursor.createdAt),
                    sql`${factRelationships.id} < ${input.cursor.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(factRelationships.createdAt), desc(factRelationships.id))
        .limit(input.limit);
    },
    async listFactRelationshipsForFacts(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        factId: string;
        cursor?: { createdAt: Date; id: string } | null;
      }[];
      limitPerFact: number;
      sourceVisibility?: SQL;
      targetVisibility?: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.factId}::uuid, ${page.cursor?.createdAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_fact_relationships"("page_key", "fact_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_fact_relationships"."page_key"`;
      const requestedFactId = sql<string>`"requested_fact_relationships"."fact_id"`;
      const cursorAt = sql<Date | null>`"requested_fact_relationships"."cursor_at"`;
      const cursorId = sql<
        string | null
      >`"requested_fact_relationships"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          parentFactId: requestedFactId.as("parent_fact_id"),
          ...getTableColumns(factRelationships),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${factRelationships.createdAt} desc, ${factRelationships.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          factRelationships,
          and(
            eq(factRelationships.workspaceId, input.workspaceId),
            isNull(factRelationships.deletedAt),
            or(
              eq(factRelationships.sourceFactId, requestedFactId),
              eq(factRelationships.targetFactId, requestedFactId),
            ),
            sql`(${cursorAt} IS NULL OR ${factRelationships.createdAt} < ${cursorAt} OR (${factRelationships.createdAt} = ${cursorAt} AND ${factRelationships.id} < ${cursorId}))`,
          ),
        )
        .innerJoin(
          sourceFactForRelationship,
          and(
            eq(sourceFactForRelationship.id, factRelationships.sourceFactId),
            eq(sourceFactForRelationship.workspaceId, input.workspaceId),
            isNull(sourceFactForRelationship.deletedAt),
          ),
        )
        .innerJoin(
          targetFactForRelationship,
          and(
            eq(targetFactForRelationship.id, factRelationships.targetFactId),
            eq(targetFactForRelationship.workspaceId, input.workspaceId),
            isNull(targetFactForRelationship.deletedAt),
          ),
        )
        .where(and(input.sourceVisibility, input.targetVisibility))
        .as("ranked_fact_relationships_by_fact");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerFact))
        .orderBy(asc(ranked.pageKey), desc(ranked.createdAt), desc(ranked.id));
    },
    async archiveFactRelationship(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      actorId: string;
    }) {
      const now = new Date();
      const [row] = await database
        .update(factRelationships)
        .set({
          deletedAt: now,
          deletedBy: input.actorId,
          updatedAt: now,
          updatedBy: input.actorId,
          version: sql`${factRelationships.version} + 1`,
        })
        .where(
          and(
            eq(factRelationships.workspaceId, input.workspaceId),
            eq(factRelationships.id, input.id),
            eq(factRelationships.version, input.expectedVersion),
            isNull(factRelationships.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async resourceReferenceExists(input: {
      workspaceId: string;
      kind: "person" | "place" | "file";
      id: string;
    }) {
      const table =
        input.kind === "person"
          ? people
          : input.kind === "place"
            ? places
            : files;
      const [row] = await database
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.workspaceId, input.workspaceId),
            eq(table.id, input.id),
            isNull(table.deletedAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async getResourceReference(input: {
      workspaceId: string;
      kind: "person" | "place" | "file";
      id: string;
    }) {
      const table =
        input.kind === "person"
          ? people
          : input.kind === "place"
            ? places
            : files;
      const [row] = await database
        .select({ id: table.id, sensitivity: table.sensitivity })
        .from(table)
        .where(
          and(
            eq(table.workspaceId, input.workspaceId),
            eq(table.id, input.id),
            isNull(table.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getResourceReferences(input: {
      workspaceId: string;
      kind: "person" | "place" | "file";
      ids: readonly string[];
    }) {
      if (!input.ids.length) return [];
      const table =
        input.kind === "person"
          ? people
          : input.kind === "place"
            ? places
            : files;
      return database
        .select({ id: table.id, sensitivity: table.sensitivity })
        .from(table)
        .where(
          and(
            eq(table.workspaceId, input.workspaceId),
            inArray(table.id, [...input.ids]),
            isNull(table.deletedAt),
          ),
        );
    },
  };
}
