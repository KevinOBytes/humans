import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  evidenceExcerpts,
  evidenceItems,
  factEvidence,
  factTags,
  notes,
  personTags,
  relationshipEvidence,
  relationshipTags,
  sources,
  tags,
} from "@/db/schema/evidence";
import { facts } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import { relationships } from "@/db/schema/relationships";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type SourceRow = typeof sources.$inferSelect;
export type EvidenceItemRow = typeof evidenceItems.$inferSelect;
export type EvidenceExcerptRow = typeof evidenceExcerpts.$inferSelect;
export type FactEvidenceRow = typeof factEvidence.$inferSelect;
export type RelationshipEvidenceRow = typeof relationshipEvidence.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type PersonTagRow = typeof personTags.$inferSelect;
export type FactTagRow = typeof factTags.$inferSelect;
export type RelationshipTagRow = typeof relationshipTags.$inferSelect;

export function createEvidenceRepository(database: Database) {
  return {
    async getSource(input: {
      workspaceId: string;
      id: string;
      visibility?: SQL;
    }) {
      const [row] = await database
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.workspaceId, input.workspaceId),
            eq(sources.id, input.id),
            isNull(sources.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getSourceForUpdate(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.workspaceId, input.workspaceId),
            eq(sources.id, input.id),
            isNull(sources.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getSourcesByIds(input: {
      workspaceId: string;
      ids: readonly string[];
      visibility?: SQL;
    }) {
      if (!input.ids.length) return [];
      return database
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.workspaceId, input.workspaceId),
            inArray(sources.id, [...input.ids]),
            isNull(sources.deletedAt),
            input.visibility,
          ),
        );
    },
    async listSources(input: {
      workspaceId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      visibility?: SQL;
      kind?: string | null;
      sensitivity?: SourceRow["sensitivity"] | null;
    }) {
      return database
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.workspaceId, input.workspaceId),
            isNull(sources.deletedAt),
            input.visibility,
            input.kind ? eq(sources.kind, input.kind) : undefined,
            input.sensitivity
              ? eq(sources.sensitivity, input.sensitivity)
              : undefined,
            input.cursor
              ? or(
                  lt(sources.createdAt, input.cursor.createdAt),
                  and(
                    eq(sources.createdAt, input.cursor.createdAt),
                    lt(sources.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(sources.createdAt), desc(sources.id))
        .limit(input.limit);
    },
    async createSource(input: {
      workspaceId: string;
      value: Omit<typeof sources.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(sources)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Source insert failed");
      return row;
    },
    async updateSource(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof sources.$inferInsert>;
    }) {
      const [row] = await database
        .update(sources)
        .set({ ...input.patch, version: sql`${sources.version} + 1` })
        .where(
          and(
            eq(sources.workspaceId, input.workspaceId),
            eq(sources.id, input.id),
            eq(sources.version, input.expectedVersion),
            isNull(sources.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async hasActiveEvidenceForSource(input: {
      workspaceId: string;
      sourceId: string;
    }) {
      const [row] = await database
        .select({ id: evidenceItems.id })
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            eq(evidenceItems.sourceId, input.sourceId),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async archiveSource(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof sources.$inferInsert>;
    }) {
      const [row] = await database
        .update(sources)
        .set({ ...input.patch, version: sql`${sources.version} + 1` })
        .where(
          and(
            eq(sources.workspaceId, input.workspaceId),
            eq(sources.id, input.id),
            eq(sources.version, input.expectedVersion),
            isNull(sources.deletedAt),
            sql`NOT EXISTS (
              SELECT 1 FROM ${evidenceItems}
              WHERE ${evidenceItems.workspaceId} = ${input.workspaceId}::uuid
                AND ${evidenceItems.sourceId} = ${sources.id}
                AND ${evidenceItems.deletedAt} IS NULL
            )`,
          ),
        )
        .returning();
      return row ?? null;
    },
    async getEvidence(input: {
      workspaceId: string;
      id: string;
      visibility?: SQL;
    }) {
      const [row] = await database
        .select()
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            eq(evidenceItems.id, input.id),
            isNull(evidenceItems.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getEvidenceForUpdate(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            eq(evidenceItems.id, input.id),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async getEvidenceByIds(input: {
      workspaceId: string;
      ids: readonly string[];
      visibility?: SQL;
    }) {
      if (!input.ids.length) return [];
      return database
        .select()
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            inArray(evidenceItems.id, [...input.ids]),
            isNull(evidenceItems.deletedAt),
            input.visibility,
          ),
        );
    },
    async listEvidence(input: {
      workspaceId: string;
      limit: number;
      sourceId?: string | null;
      cursor?: { createdAt: Date; id: string } | null;
      visibility?: SQL;
      sourceVisibility?: SQL;
      reviewState?: string | null;
      sensitivity?: EvidenceItemRow["sensitivity"] | null;
    }) {
      return database
        .select()
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            isNull(evidenceItems.deletedAt),
            input.visibility,
            input.reviewState
              ? eq(evidenceItems.reviewState, input.reviewState)
              : undefined,
            input.sensitivity
              ? eq(evidenceItems.sensitivity, input.sensitivity)
              : undefined,
            input.sourceId
              ? sql`EXISTS (
                  SELECT 1 FROM ${sources}
                  WHERE ${sources.workspaceId} = ${input.workspaceId}::uuid
                    AND ${sources.id} = ${input.sourceId}::uuid
                    AND ${sources.id} = ${evidenceItems.sourceId}
                    AND ${sources.deletedAt} IS NULL
                    AND ${input.sourceVisibility}
                )`
              : undefined,
            input.cursor
              ? or(
                  lt(evidenceItems.createdAt, input.cursor.createdAt),
                  and(
                    eq(evidenceItems.createdAt, input.cursor.createdAt),
                    lt(evidenceItems.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(evidenceItems.createdAt), desc(evidenceItems.id))
        .limit(input.limit);
    },
    async createEvidence(input: {
      workspaceId: string;
      value: Omit<typeof evidenceItems.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(evidenceItems)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Evidence insert failed");
      return row;
    },
    async updateEvidence(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof evidenceItems.$inferInsert>;
    }) {
      const [row] = await database
        .update(evidenceItems)
        .set({ ...input.patch, version: sql`${evidenceItems.version} + 1` })
        .where(
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            eq(evidenceItems.id, input.id),
            eq(evidenceItems.version, input.expectedVersion),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async createExcerpt(input: {
      workspaceId: string;
      value: Omit<typeof evidenceExcerpts.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(evidenceExcerpts)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Excerpt insert failed");
      return row;
    },
    async listExcerpts(input: {
      workspaceId: string;
      evidenceItemId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
    }) {
      return database
        .select()
        .from(evidenceExcerpts)
        .where(
          and(
            eq(evidenceExcerpts.workspaceId, input.workspaceId),
            eq(evidenceExcerpts.evidenceItemId, input.evidenceItemId),
            input.cursor
              ? or(
                  lt(evidenceExcerpts.createdAt, input.cursor.createdAt),
                  and(
                    eq(evidenceExcerpts.createdAt, input.cursor.createdAt),
                    lt(evidenceExcerpts.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(evidenceExcerpts.createdAt), desc(evidenceExcerpts.id))
        .limit(input.limit);
    },
    async listExcerptsForEvidenceItems(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        evidenceItemId: string;
        cursor?: { createdAt: Date; id: string } | null;
      }[];
      limitPerEvidenceItem: number;
      evidenceVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.evidenceItemId}::uuid, ${page.cursor?.createdAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_excerpt_pages"("page_key", "evidence_item_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_excerpt_pages"."page_key"`;
      const evidenceItemId = sql<string>`"requested_excerpt_pages"."evidence_item_id"`;
      const cursorAt = sql<Date | null>`"requested_excerpt_pages"."cursor_at"`;
      const cursorId = sql<
        string | null
      >`"requested_excerpt_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(evidenceExcerpts),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${evidenceExcerpts.createdAt} desc, ${evidenceExcerpts.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          evidenceExcerpts,
          and(
            eq(evidenceExcerpts.workspaceId, input.workspaceId),
            sql`${evidenceExcerpts.evidenceItemId} = ${evidenceItemId}`,
            sql`(${cursorAt} IS NULL OR ${evidenceExcerpts.createdAt} < ${cursorAt} OR (${evidenceExcerpts.createdAt} = ${cursorAt} AND ${evidenceExcerpts.id} < ${cursorId}))`,
          ),
        )
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, input.workspaceId),
            sql`${evidenceItems.id} = ${evidenceItemId}`,
            isNull(evidenceItems.deletedAt),
            input.evidenceVisibility,
          ),
        )
        .as("ranked_excerpt_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerEvidenceItem))
        .orderBy(asc(ranked.pageKey), desc(ranked.createdAt), desc(ranked.id));
    },
    async getFactEvidence(input: {
      workspaceId: string;
      factId: string;
      evidenceItemId: string;
    }) {
      const [row] = await database
        .select()
        .from(factEvidence)
        .where(
          and(
            eq(factEvidence.workspaceId, input.workspaceId),
            eq(factEvidence.factId, input.factId),
            eq(factEvidence.evidenceItemId, input.evidenceItemId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async createFactEvidence(input: {
      workspaceId: string;
      value: Omit<typeof factEvidence.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(factEvidence)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Fact evidence insert failed");
      return row;
    },
    async listFactEvidence(input: {
      workspaceId: string;
      factId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      evidenceVisibility: SQL;
    }) {
      return database
        .select(getTableColumns(factEvidence))
        .from(factEvidence)
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, factEvidence.workspaceId),
            eq(evidenceItems.id, factEvidence.evidenceItemId),
            isNull(evidenceItems.deletedAt),
            input.evidenceVisibility,
          ),
        )
        .where(
          and(
            eq(factEvidence.workspaceId, input.workspaceId),
            eq(factEvidence.factId, input.factId),
            input.cursor
              ? or(
                  lt(factEvidence.createdAt, input.cursor.createdAt),
                  and(
                    eq(factEvidence.createdAt, input.cursor.createdAt),
                    lt(factEvidence.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(factEvidence.createdAt), desc(factEvidence.id))
        .limit(input.limit);
    },
    async listFactEvidenceForFacts(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        factId: string;
        cursor?: { createdAt: Date; id: string } | null;
      }[];
      limitPerFact: number;
      evidenceVisibility: SQL;
      factVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.factId}::uuid, ${page.cursor?.createdAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_fact_evidence_pages"("page_key", "fact_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_fact_evidence_pages"."page_key"`;
      const factId = sql<string>`"requested_fact_evidence_pages"."fact_id"`;
      const cursorAt = sql<Date | null>`"requested_fact_evidence_pages"."cursor_at"`;
      const cursorId = sql<
        string | null
      >`"requested_fact_evidence_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(factEvidence),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${factEvidence.createdAt} desc, ${factEvidence.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          factEvidence,
          and(
            eq(factEvidence.workspaceId, input.workspaceId),
            sql`${factEvidence.factId} = ${factId}`,
            sql`(${cursorAt} IS NULL OR ${factEvidence.createdAt} < ${cursorAt} OR (${factEvidence.createdAt} = ${cursorAt} AND ${factEvidence.id} < ${cursorId}))`,
          ),
        )
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, factEvidence.workspaceId),
            eq(evidenceItems.id, factEvidence.evidenceItemId),
            isNull(evidenceItems.deletedAt),
            input.evidenceVisibility,
          ),
        )
        .innerJoin(
          facts,
          and(
            eq(facts.workspaceId, input.workspaceId),
            sql`${facts.id} = ${factId}`,
            isNull(facts.deletedAt),
            input.factVisibility,
          ),
        )
        .as("ranked_fact_evidence_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerFact))
        .orderBy(asc(ranked.pageKey), desc(ranked.createdAt), desc(ranked.id));
    },
    async deleteFactEvidence(input: {
      workspaceId: string;
      factId: string;
      evidenceItemId: string;
    }) {
      return database
        .delete(factEvidence)
        .where(
          and(
            eq(factEvidence.workspaceId, input.workspaceId),
            eq(factEvidence.factId, input.factId),
            eq(factEvidence.evidenceItemId, input.evidenceItemId),
          ),
        )
        .returning();
    },
    async getRelationshipEvidence(input: {
      workspaceId: string;
      relationshipId: string;
      evidenceItemId: string;
    }) {
      const [row] = await database
        .select()
        .from(relationshipEvidence)
        .where(
          and(
            eq(relationshipEvidence.workspaceId, input.workspaceId),
            eq(relationshipEvidence.relationshipId, input.relationshipId),
            eq(relationshipEvidence.evidenceItemId, input.evidenceItemId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async createRelationshipEvidence(input: {
      workspaceId: string;
      value: Omit<typeof relationshipEvidence.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(relationshipEvidence)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Relationship evidence insert failed");
      return row;
    },
    async listRelationshipEvidence(input: {
      workspaceId: string;
      relationshipId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      evidenceVisibility: SQL;
    }) {
      return database
        .select(getTableColumns(relationshipEvidence))
        .from(relationshipEvidence)
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, relationshipEvidence.workspaceId),
            eq(evidenceItems.id, relationshipEvidence.evidenceItemId),
            isNull(evidenceItems.deletedAt),
            input.evidenceVisibility,
          ),
        )
        .where(
          and(
            eq(relationshipEvidence.workspaceId, input.workspaceId),
            eq(relationshipEvidence.relationshipId, input.relationshipId),
            input.cursor
              ? or(
                  lt(relationshipEvidence.createdAt, input.cursor.createdAt),
                  and(
                    eq(relationshipEvidence.createdAt, input.cursor.createdAt),
                    lt(relationshipEvidence.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(relationshipEvidence.createdAt),
          desc(relationshipEvidence.id),
        )
        .limit(input.limit);
    },
    async listRelationshipEvidenceForRelationships(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        relationshipId: string;
        cursor?: { createdAt: Date; id: string } | null;
      }[];
      limitPerRelationship: number;
      evidenceVisibility: SQL;
      relationshipVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.relationshipId}::uuid, ${page.cursor?.createdAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_relationship_evidence_pages"("page_key", "relationship_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_relationship_evidence_pages"."page_key"`;
      const relationshipId = sql<string>`"requested_relationship_evidence_pages"."relationship_id"`;
      const cursorAt = sql<Date | null>`"requested_relationship_evidence_pages"."cursor_at"`;
      const cursorId = sql<
        string | null
      >`"requested_relationship_evidence_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(relationshipEvidence),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${relationshipEvidence.createdAt} desc, ${relationshipEvidence.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          relationshipEvidence,
          and(
            eq(relationshipEvidence.workspaceId, input.workspaceId),
            sql`${relationshipEvidence.relationshipId} = ${relationshipId}`,
            sql`(${cursorAt} IS NULL OR ${relationshipEvidence.createdAt} < ${cursorAt} OR (${relationshipEvidence.createdAt} = ${cursorAt} AND ${relationshipEvidence.id} < ${cursorId}))`,
          ),
        )
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, relationshipEvidence.workspaceId),
            eq(evidenceItems.id, relationshipEvidence.evidenceItemId),
            isNull(evidenceItems.deletedAt),
            input.evidenceVisibility,
          ),
        )
        .innerJoin(
          relationships,
          and(
            eq(relationships.workspaceId, input.workspaceId),
            sql`${relationships.id} = ${relationshipId}`,
            isNull(relationships.deletedAt),
            input.relationshipVisibility,
          ),
        )
        .as("ranked_relationship_evidence_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerRelationship))
        .orderBy(asc(ranked.pageKey), desc(ranked.createdAt), desc(ranked.id));
    },
    async deleteRelationshipEvidence(input: {
      workspaceId: string;
      relationshipId: string;
      evidenceItemId: string;
    }) {
      return database
        .delete(relationshipEvidence)
        .where(
          and(
            eq(relationshipEvidence.workspaceId, input.workspaceId),
            eq(relationshipEvidence.relationshipId, input.relationshipId),
            eq(relationshipEvidence.evidenceItemId, input.evidenceItemId),
          ),
        )
        .returning();
    },
    async getNote(input: {
      workspaceId: string;
      id: string;
      visibility?: SQL;
      subjectVisibility?: SQL;
    }) {
      const [row] = await database
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.workspaceId, input.workspaceId),
            eq(notes.id, input.id),
            isNull(notes.deletedAt),
            input.visibility,
            input.subjectVisibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async listNotes(input: {
      workspaceId: string;
      limit: number;
      personId?: string | null;
      factId?: string | null;
      relationshipId?: string | null;
      evidenceItemId?: string | null;
      cursor?: { updatedAt: Date; id: string } | null;
      visibility?: SQL;
      subjectVisibility?: SQL;
      sensitivity?: NoteRow["sensitivity"] | null;
    }) {
      return database
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.workspaceId, input.workspaceId),
            isNull(notes.deletedAt),
            input.visibility,
            input.subjectVisibility,
            input.sensitivity
              ? eq(notes.sensitivity, input.sensitivity)
              : undefined,
            input.personId ? eq(notes.personId, input.personId) : undefined,
            input.factId ? eq(notes.factId, input.factId) : undefined,
            input.relationshipId
              ? eq(notes.relationshipId, input.relationshipId)
              : undefined,
            input.evidenceItemId
              ? eq(notes.evidenceItemId, input.evidenceItemId)
              : undefined,
            input.cursor
              ? or(
                  lt(notes.updatedAt, input.cursor.updatedAt),
                  and(
                    eq(notes.updatedAt, input.cursor.updatedAt),
                    lt(notes.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(notes.updatedAt), desc(notes.id))
        .limit(input.limit);
    },
    async listNotesForSubjects(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        kind: "person" | "fact" | "relationship" | "evidence";
        subjectId: string;
        cursor?: { updatedAt: Date; id: string } | null;
      }[];
      limitPerSubject: number;
      visibility?: SQL;
      subjectVisibility?: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.kind}::text, ${page.subjectId}::uuid, ${page.cursor?.updatedAt.toISOString() ?? null}::timestamptz, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_note_pages"("page_key", "subject_kind", "subject_id", "cursor_at", "cursor_id")`;
      const pageKey = sql<number>`"requested_note_pages"."page_key"`;
      const subjectKind = sql<string>`"requested_note_pages"."subject_kind"`;
      const subjectId = sql<string>`"requested_note_pages"."subject_id"`;
      const cursorAt = sql<Date | null>`"requested_note_pages"."cursor_at"`;
      const cursorId = sql<string | null>`"requested_note_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(notes),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${notes.updatedAt} desc, ${notes.id} desc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          notes,
          and(
            eq(notes.workspaceId, input.workspaceId),
            isNull(notes.deletedAt),
            input.visibility,
            input.subjectVisibility,
            or(
              and(
                sql`${subjectKind} = 'person'`,
                sql`${notes.personId} = ${subjectId}`,
              ),
              and(
                sql`${subjectKind} = 'fact'`,
                sql`${notes.factId} = ${subjectId}`,
              ),
              and(
                sql`${subjectKind} = 'relationship'`,
                sql`${notes.relationshipId} = ${subjectId}`,
              ),
              and(
                sql`${subjectKind} = 'evidence'`,
                sql`${notes.evidenceItemId} = ${subjectId}`,
              ),
            ),
            sql`(${cursorAt} IS NULL OR ${notes.updatedAt} < ${cursorAt} OR (${notes.updatedAt} = ${cursorAt} AND ${notes.id} < ${cursorId}))`,
          ),
        )
        .as("ranked_note_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerSubject))
        .orderBy(asc(ranked.pageKey), desc(ranked.updatedAt), desc(ranked.id));
    },
    async createNote(input: {
      workspaceId: string;
      value: Omit<typeof notes.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(notes)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Note insert failed");
      return row;
    },
    async updateNote(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof notes.$inferInsert>;
    }) {
      const [row] = await database
        .update(notes)
        .set({ ...input.patch, version: sql`${notes.version} + 1` })
        .where(
          and(
            eq(notes.workspaceId, input.workspaceId),
            eq(notes.id, input.id),
            eq(notes.version, input.expectedVersion),
            isNull(notes.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async getTag(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(tags)
        .where(
          and(
            eq(tags.workspaceId, input.workspaceId),
            eq(tags.id, input.id),
            isNull(tags.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getTagsByIds(input: { workspaceId: string; ids: readonly string[] }) {
      if (!input.ids.length) return [];
      return database
        .select()
        .from(tags)
        .where(
          and(
            eq(tags.workspaceId, input.workspaceId),
            inArray(tags.id, [...input.ids]),
            isNull(tags.deletedAt),
          ),
        );
    },
    async listTags(input: {
      workspaceId: string;
      limit: number;
      cursor?: { normalizedName: string; id: string } | null;
      normalizedNamePrefix?: string | null;
    }) {
      return database
        .select()
        .from(tags)
        .where(
          and(
            eq(tags.workspaceId, input.workspaceId),
            isNull(tags.deletedAt),
            input.normalizedNamePrefix
              ? sql`${tags.normalizedName} LIKE ${`${input.normalizedNamePrefix}%`}`
              : undefined,
            input.cursor
              ? or(
                  gt(tags.normalizedName, input.cursor.normalizedName),
                  and(
                    eq(tags.normalizedName, input.cursor.normalizedName),
                    gt(tags.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(tags.normalizedName), asc(tags.id))
        .limit(input.limit);
    },
    async createTag(input: {
      workspaceId: string;
      value: Omit<typeof tags.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(tags)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
    async updateTag(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<typeof tags.$inferInsert>;
    }) {
      const [row] = await database
        .update(tags)
        .set({ ...input.patch, version: sql`${tags.version} + 1` })
        .where(
          and(
            eq(tags.workspaceId, input.workspaceId),
            eq(tags.id, input.id),
            eq(tags.version, input.expectedVersion),
            isNull(tags.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async getPersonTag(input: {
      workspaceId: string;
      personId: string;
      tagId: string;
    }) {
      const [row] = await database
        .select()
        .from(personTags)
        .where(
          and(
            eq(personTags.workspaceId, input.workspaceId),
            eq(personTags.personId, input.personId),
            eq(personTags.tagId, input.tagId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async createPersonTag(input: {
      workspaceId: string;
      value: Omit<typeof personTags.$inferInsert, "workspaceId">;
    }) {
      const [created] = await database
        .insert(personTags)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [existing] = await database
        .select()
        .from(personTags)
        .where(
          and(
            eq(personTags.workspaceId, input.workspaceId),
            eq(personTags.personId, input.value.personId),
            eq(personTags.tagId, input.value.tagId),
          ),
        )
        .limit(1);
      return existing ?? null;
    },
    async listPersonTags(input: {
      workspaceId: string;
      personId: string;
      limit: number;
    }) {
      return database
        .select()
        .from(personTags)
        .where(
          and(
            eq(personTags.workspaceId, input.workspaceId),
            eq(personTags.personId, input.personId),
          ),
        )
        .orderBy(asc(personTags.createdAt), asc(personTags.id))
        .limit(input.limit);
    },
    async listTagRowsForPerson(input: {
      workspaceId: string;
      personId: string;
      limit: number;
      cursor?: { normalizedName: string; id: string } | null;
    }) {
      return database
        .select({ tag: tags })
        .from(personTags)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, personTags.workspaceId),
            eq(tags.id, personTags.tagId),
          ),
        )
        .where(
          and(
            eq(personTags.workspaceId, input.workspaceId),
            eq(personTags.personId, input.personId),
            isNull(tags.deletedAt),
            input.cursor
              ? or(
                  gt(tags.normalizedName, input.cursor.normalizedName),
                  and(
                    eq(tags.normalizedName, input.cursor.normalizedName),
                    gt(tags.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(tags.normalizedName), asc(tags.id))
        .limit(input.limit);
    },
    async listTagRowsForPeople(input: {
      workspaceId: string;
      personIds: readonly string[];
      limitPerPerson: number;
    }) {
      if (!input.personIds.length) return [];
      const ranked = database
        .select({
          subjectId: personTags.personId,
          ...getTableColumns(tags),
          pageRank:
            sql<number>`row_number() over (partition by ${personTags.personId} order by ${tags.normalizedName} asc, ${tags.id} asc)`.as(
              "page_rank",
            ),
        })
        .from(personTags)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, personTags.workspaceId),
            eq(tags.id, personTags.tagId),
            isNull(tags.deletedAt),
          ),
        )
        .where(
          and(
            eq(personTags.workspaceId, input.workspaceId),
            inArray(personTags.personId, [...input.personIds]),
          ),
        )
        .as("ranked_person_tags");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerPerson))
        .orderBy(
          asc(ranked.subjectId),
          asc(ranked.normalizedName),
          asc(ranked.id),
        );
    },
    async deletePersonTag(input: {
      workspaceId: string;
      personId: string;
      tagId: string;
    }) {
      return database
        .delete(personTags)
        .where(
          and(
            eq(personTags.workspaceId, input.workspaceId),
            eq(personTags.personId, input.personId),
            eq(personTags.tagId, input.tagId),
          ),
        )
        .returning();
    },
    async getFactTag(input: {
      workspaceId: string;
      factId: string;
      tagId: string;
    }) {
      const [row] = await database
        .select()
        .from(factTags)
        .where(
          and(
            eq(factTags.workspaceId, input.workspaceId),
            eq(factTags.factId, input.factId),
            eq(factTags.tagId, input.tagId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async createFactTag(input: {
      workspaceId: string;
      value: Omit<typeof factTags.$inferInsert, "workspaceId">;
    }) {
      const [created] = await database
        .insert(factTags)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [existing] = await database
        .select()
        .from(factTags)
        .where(
          and(
            eq(factTags.workspaceId, input.workspaceId),
            eq(factTags.factId, input.value.factId),
            eq(factTags.tagId, input.value.tagId),
          ),
        )
        .limit(1);
      return existing ?? null;
    },
    async listFactTags(input: {
      workspaceId: string;
      factId: string;
      limit: number;
    }) {
      return database
        .select()
        .from(factTags)
        .where(
          and(
            eq(factTags.workspaceId, input.workspaceId),
            eq(factTags.factId, input.factId),
          ),
        )
        .orderBy(asc(factTags.createdAt), asc(factTags.id))
        .limit(input.limit);
    },
    async listTagRowsForFact(input: {
      workspaceId: string;
      factId: string;
      limit: number;
      cursor?: { normalizedName: string; id: string } | null;
    }) {
      return database
        .select({ tag: tags })
        .from(factTags)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, factTags.workspaceId),
            eq(tags.id, factTags.tagId),
          ),
        )
        .where(
          and(
            eq(factTags.workspaceId, input.workspaceId),
            eq(factTags.factId, input.factId),
            isNull(tags.deletedAt),
            input.cursor
              ? or(
                  gt(tags.normalizedName, input.cursor.normalizedName),
                  and(
                    eq(tags.normalizedName, input.cursor.normalizedName),
                    gt(tags.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(tags.normalizedName), asc(tags.id))
        .limit(input.limit);
    },
    async listTagRowsForFacts(input: {
      workspaceId: string;
      factIds: readonly string[];
      limitPerFact: number;
    }) {
      if (!input.factIds.length) return [];
      const ranked = database
        .select({
          subjectId: factTags.factId,
          ...getTableColumns(tags),
          pageRank:
            sql<number>`row_number() over (partition by ${factTags.factId} order by ${tags.normalizedName} asc, ${tags.id} asc)`.as(
              "page_rank",
            ),
        })
        .from(factTags)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, factTags.workspaceId),
            eq(tags.id, factTags.tagId),
            isNull(tags.deletedAt),
          ),
        )
        .where(
          and(
            eq(factTags.workspaceId, input.workspaceId),
            inArray(factTags.factId, [...input.factIds]),
          ),
        )
        .as("ranked_fact_tags");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerFact))
        .orderBy(
          asc(ranked.subjectId),
          asc(ranked.normalizedName),
          asc(ranked.id),
        );
    },
    async deleteFactTag(input: {
      workspaceId: string;
      factId: string;
      tagId: string;
    }) {
      return database
        .delete(factTags)
        .where(
          and(
            eq(factTags.workspaceId, input.workspaceId),
            eq(factTags.factId, input.factId),
            eq(factTags.tagId, input.tagId),
          ),
        )
        .returning();
    },
    async getRelationshipTag(input: {
      workspaceId: string;
      relationshipId: string;
      tagId: string;
    }) {
      const [row] = await database
        .select()
        .from(relationshipTags)
        .where(
          and(
            eq(relationshipTags.workspaceId, input.workspaceId),
            eq(relationshipTags.relationshipId, input.relationshipId),
            eq(relationshipTags.tagId, input.tagId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async createRelationshipTag(input: {
      workspaceId: string;
      value: Omit<typeof relationshipTags.$inferInsert, "workspaceId">;
    }) {
      const [created] = await database
        .insert(relationshipTags)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [existing] = await database
        .select()
        .from(relationshipTags)
        .where(
          and(
            eq(relationshipTags.workspaceId, input.workspaceId),
            eq(relationshipTags.relationshipId, input.value.relationshipId),
            eq(relationshipTags.tagId, input.value.tagId),
          ),
        )
        .limit(1);
      return existing ?? null;
    },
    async listRelationshipTags(input: {
      workspaceId: string;
      relationshipId: string;
      limit: number;
    }) {
      return database
        .select()
        .from(relationshipTags)
        .where(
          and(
            eq(relationshipTags.workspaceId, input.workspaceId),
            eq(relationshipTags.relationshipId, input.relationshipId),
          ),
        )
        .orderBy(asc(relationshipTags.createdAt), asc(relationshipTags.id))
        .limit(input.limit);
    },
    async listTagRowsForRelationship(input: {
      workspaceId: string;
      relationshipId: string;
      limit: number;
      cursor?: { normalizedName: string; id: string } | null;
    }) {
      return database
        .select({ tag: tags })
        .from(relationshipTags)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, relationshipTags.workspaceId),
            eq(tags.id, relationshipTags.tagId),
          ),
        )
        .where(
          and(
            eq(relationshipTags.workspaceId, input.workspaceId),
            eq(relationshipTags.relationshipId, input.relationshipId),
            isNull(tags.deletedAt),
            input.cursor
              ? or(
                  gt(tags.normalizedName, input.cursor.normalizedName),
                  and(
                    eq(tags.normalizedName, input.cursor.normalizedName),
                    gt(tags.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(tags.normalizedName), asc(tags.id))
        .limit(input.limit);
    },
    async listTagRowsForRelationships(input: {
      workspaceId: string;
      relationshipIds: readonly string[];
      limitPerRelationship: number;
    }) {
      if (!input.relationshipIds.length) return [];
      const ranked = database
        .select({
          subjectId: relationshipTags.relationshipId,
          ...getTableColumns(tags),
          pageRank:
            sql<number>`row_number() over (partition by ${relationshipTags.relationshipId} order by ${tags.normalizedName} asc, ${tags.id} asc)`.as(
              "page_rank",
            ),
        })
        .from(relationshipTags)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, relationshipTags.workspaceId),
            eq(tags.id, relationshipTags.tagId),
            isNull(tags.deletedAt),
          ),
        )
        .where(
          and(
            eq(relationshipTags.workspaceId, input.workspaceId),
            inArray(relationshipTags.relationshipId, [
              ...input.relationshipIds,
            ]),
          ),
        )
        .as("ranked_relationship_tags");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerRelationship))
        .orderBy(
          asc(ranked.subjectId),
          asc(ranked.normalizedName),
          asc(ranked.id),
        );
    },
    async listTagRowsForSubjects(input: {
      workspaceId: string;
      pages: readonly {
        pageKey: number;
        kind: "person" | "fact" | "relationship";
        subjectId: string;
        cursor?: { normalizedName: string; id: string } | null;
      }[];
      limitPerSubject: number;
      personVisibility: SQL;
      factVisibility: SQL;
      relationshipVisibility: SQL;
    }) {
      if (!input.pages.length) return [];
      const requested = sql`(values ${sql.join(
        input.pages.map(
          (page) =>
            sql`(${page.pageKey}::integer, ${page.kind}::text, ${page.subjectId}::uuid, ${page.cursor?.normalizedName ?? null}::text, ${page.cursor?.id ?? null}::uuid)`,
        ),
        sql`, `,
      )}) as "requested_tag_pages"("page_key", "subject_kind", "subject_id", "cursor_name", "cursor_id")`;
      const pageKey = sql<number>`"requested_tag_pages"."page_key"`;
      const subjectKind = sql<string>`"requested_tag_pages"."subject_kind"`;
      const subjectId = sql<string>`"requested_tag_pages"."subject_id"`;
      const cursorName = sql<
        string | null
      >`"requested_tag_pages"."cursor_name"`;
      const cursorId = sql<string | null>`"requested_tag_pages"."cursor_id"`;
      const ranked = database
        .select({
          pageKey: pageKey.as("page_key"),
          ...getTableColumns(tags),
          pageRank:
            sql<number>`row_number() over (partition by ${pageKey} order by ${tags.normalizedName} asc, ${tags.id} asc)`.as(
              "page_rank",
            ),
        })
        .from(requested)
        .innerJoin(
          tags,
          and(
            eq(tags.workspaceId, input.workspaceId),
            isNull(tags.deletedAt),
            or(
              sql`(${subjectKind} = 'person' AND EXISTS (
                SELECT 1 FROM ${personTags}
                INNER JOIN ${people}
                  ON ${people.workspaceId} = ${personTags.workspaceId}
                 AND ${people.id} = ${personTags.personId}
                 AND ${people.deletedAt} IS NULL
                 AND ${input.personVisibility}
                WHERE ${personTags.workspaceId} = ${input.workspaceId}::uuid
                  AND ${personTags.personId} = ${subjectId}
                  AND ${personTags.tagId} = ${tags.id}
              ))`,
              sql`(${subjectKind} = 'fact' AND EXISTS (
                SELECT 1 FROM ${factTags}
                INNER JOIN ${facts}
                  ON ${facts.workspaceId} = ${factTags.workspaceId}
                 AND ${facts.id} = ${factTags.factId}
                 AND ${facts.deletedAt} IS NULL
                 AND ${input.factVisibility}
                WHERE ${factTags.workspaceId} = ${input.workspaceId}::uuid
                  AND ${factTags.factId} = ${subjectId}
                  AND ${factTags.tagId} = ${tags.id}
              ))`,
              sql`(${subjectKind} = 'relationship' AND EXISTS (
                SELECT 1 FROM ${relationshipTags}
                INNER JOIN ${relationships}
                  ON ${relationships.workspaceId} = ${relationshipTags.workspaceId}
                 AND ${relationships.id} = ${relationshipTags.relationshipId}
                 AND ${relationships.deletedAt} IS NULL
                 AND ${input.relationshipVisibility}
                WHERE ${relationshipTags.workspaceId} = ${input.workspaceId}::uuid
                  AND ${relationshipTags.relationshipId} = ${subjectId}
                  AND ${relationshipTags.tagId} = ${tags.id}
              ))`,
            ),
            sql`(${cursorName} IS NULL OR ${tags.normalizedName} > ${cursorName} OR (${tags.normalizedName} = ${cursorName} AND ${tags.id} > ${cursorId}))`,
          ),
        )
        .as("ranked_tag_pages");
      return database
        .select()
        .from(ranked)
        .where(lte(ranked.pageRank, input.limitPerSubject))
        .orderBy(
          asc(ranked.pageKey),
          asc(ranked.normalizedName),
          asc(ranked.id),
        );
    },
    async deleteRelationshipTag(input: {
      workspaceId: string;
      relationshipId: string;
      tagId: string;
    }) {
      return database
        .delete(relationshipTags)
        .where(
          and(
            eq(relationshipTags.workspaceId, input.workspaceId),
            eq(relationshipTags.relationshipId, input.relationshipId),
            eq(relationshipTags.tagId, input.tagId),
          ),
        )
        .returning();
    },
  };
}
