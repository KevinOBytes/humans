import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { people, personEvents, personNames } from "@/db/schema/people";
import { files } from "@/db/schema/files";
import { facts } from "@/db/schema/facts";
import {
  evidenceItems,
  factEvidence,
  personAddresses,
  personContactPoints,
} from "@/db/schema/evidence";
import { relationshipEvidence } from "@/db/schema/evidence";
import { relationships } from "@/db/schema/relationships";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type PersonRow = typeof people.$inferSelect;
export type NewPersonRow = typeof people.$inferInsert;
export type PersonNameRow = typeof personNames.$inferSelect;
export type PersonEventRow = typeof personEvents.$inferSelect;
export type PersonFileRole = "primary_photo" | "fact" | "evidence";
export type PersonFileRow = typeof files.$inferSelect & {
  roles: readonly PersonFileRole[];
};

export function createPeopleRepository(database: Database) {
  return {
    async getById(input: {
      workspaceId: string;
      id: string;
      visibility?: SQL;
    }): Promise<PersonRow | null> {
      const [row] = await database
        .select()
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.id),
            isNull(people.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getByIds(input: {
      workspaceId: string;
      ids: readonly string[];
      visibility?: SQL;
    }): Promise<PersonRow[]> {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            inArray(people.id, [...input.ids]),
            isNull(people.deletedAt),
            input.visibility,
          ),
        );
    },

    async list(input: {
      workspaceId: string;
      limit: number;
      cursor?: { sort: string; id: string } | null;
      name?: string | null;
      namePrefix?: string | null;
      nameContains?: string | null;
      status?: PersonRow["status"] | null;
      sensitivity?: PersonRow["sensitivity"] | null;
      visibility?: SQL;
    }): Promise<PersonRow[]> {
      const sortExpression = sql<string>`coalesce(${people.sortName}, ${people.displayName})`;
      return database
        .select()
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            isNull(people.deletedAt),
            input.visibility,
            input.name
              ? sql`${people.displayName} ILIKE ${`%${input.name}%`}`
              : undefined,
            input.namePrefix
              ? sql`${people.displayName} ILIKE ${`${input.namePrefix}%`}`
              : undefined,
            input.nameContains
              ? sql`${people.displayName} ILIKE ${`%${input.nameContains}%`}`
              : undefined,
            input.status ? eq(people.status, input.status) : undefined,
            input.sensitivity
              ? eq(people.sensitivity, input.sensitivity)
              : undefined,
            input.cursor
              ? sql`(${sortExpression}, ${people.id}) > (${input.cursor.sort}, ${input.cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(sortExpression), asc(people.id))
        .limit(input.limit);
    },

    async listRecent(input: {
      workspaceId: string;
      limit: number;
      cursor?: { updatedAt: Date; id: string } | null;
      visibility?: SQL;
    }): Promise<PersonRow[]> {
      return database
        .select()
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            isNull(people.deletedAt),
            input.visibility,
            input.cursor
              ? or(
                  lt(people.updatedAt, input.cursor.updatedAt),
                  and(
                    eq(people.updatedAt, input.cursor.updatedAt),
                    lt(people.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(people.updatedAt), desc(people.id))
        .limit(input.limit);
    },

    async listNames(input: {
      workspaceId: string;
      personId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      visibility?: SQL;
      personVisibility?: SQL;
    }): Promise<PersonNameRow[]> {
      return database
        .select(getTableColumns(personNames))
        .from(personNames)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, personNames.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .where(
          and(
            eq(personNames.workspaceId, input.workspaceId),
            eq(personNames.personId, input.personId),
            isNull(personNames.deletedAt),
            input.visibility,
            input.cursor
              ? or(
                  lt(personNames.createdAt, input.cursor.createdAt),
                  and(
                    eq(personNames.createdAt, input.cursor.createdAt),
                    lt(personNames.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(personNames.createdAt), desc(personNames.id))
        .limit(input.limit);
    },

    async listEvents(input: {
      workspaceId: string;
      personId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      visibility?: SQL;
      personVisibility?: SQL;
    }): Promise<PersonEventRow[]> {
      return database
        .select(getTableColumns(personEvents))
        .from(personEvents)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, personEvents.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .where(
          and(
            eq(personEvents.workspaceId, input.workspaceId),
            eq(personEvents.personId, input.personId),
            isNull(personEvents.deletedAt),
            input.visibility,
            input.cursor
              ? or(
                  lt(personEvents.createdAt, input.cursor.createdAt),
                  and(
                    eq(personEvents.createdAt, input.cursor.createdAt),
                    lt(personEvents.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(personEvents.createdAt), desc(personEvents.id))
        .limit(input.limit);
    },

    async listFiles(input: {
      workspaceId: string;
      personId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      visibility?: SQL;
      personVisibility?: SQL;
      factVisibility?: SQL;
      evidenceVisibility?: SQL;
      relationshipVisibility?: SQL;
    }): Promise<PersonFileRow[]> {
      const [
        primaryPhotoRefs,
        factRefs,
        factEvidenceRefs,
        relationshipEvidenceRefs,
        contactEvidenceRefs,
        addressEvidenceRefs,
      ] = await Promise.all([
        database
          .select({ fileId: people.primaryPhotoFileId })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, input.workspaceId),
              eq(people.id, input.personId),
              isNull(people.deletedAt),
              input.personVisibility,
              sql`${people.primaryPhotoFileId} IS NOT NULL`,
            ),
          ),
        database
          .select({ fileId: facts.fileId })
          .from(facts)
          .innerJoin(
            people,
            and(
              eq(people.workspaceId, input.workspaceId),
              eq(people.id, facts.personId),
              isNull(people.deletedAt),
              input.personVisibility,
            ),
          )
          .where(
            and(
              eq(facts.workspaceId, input.workspaceId),
              eq(facts.personId, input.personId),
              isNull(facts.deletedAt),
              input.factVisibility,
              sql`${facts.fileId} IS NOT NULL`,
            ),
          ),
        database
          .select({ fileId: evidenceItems.fileId })
          .from(factEvidence)
          .innerJoin(
            facts,
            and(
              eq(facts.workspaceId, input.workspaceId),
              eq(facts.id, factEvidence.factId),
              eq(facts.personId, input.personId),
              isNull(facts.deletedAt),
              input.factVisibility,
            ),
          )
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, input.workspaceId),
              eq(evidenceItems.id, factEvidence.evidenceItemId),
              isNull(evidenceItems.deletedAt),
              input.evidenceVisibility,
            ),
          )
          .where(
            and(
              eq(factEvidence.workspaceId, input.workspaceId),
              sql`${evidenceItems.fileId} IS NOT NULL`,
            ),
          ),
        database
          .select({ fileId: evidenceItems.fileId })
          .from(relationshipEvidence)
          .innerJoin(
            relationships,
            and(
              eq(relationships.workspaceId, input.workspaceId),
              eq(relationships.id, relationshipEvidence.relationshipId),
              or(
                eq(relationships.sourcePersonId, input.personId),
                eq(relationships.targetPersonId, input.personId),
              ),
              isNull(relationships.deletedAt),
              input.relationshipVisibility,
            ),
          )
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, input.workspaceId),
              eq(evidenceItems.id, relationshipEvidence.evidenceItemId),
              isNull(evidenceItems.deletedAt),
              input.evidenceVisibility,
            ),
          )
          .where(
            and(
              eq(relationshipEvidence.workspaceId, input.workspaceId),
              sql`${evidenceItems.fileId} IS NOT NULL`,
            ),
          ),
        database
          .select({ fileId: evidenceItems.fileId })
          .from(personContactPoints)
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, input.workspaceId),
              eq(evidenceItems.id, personContactPoints.evidenceId),
              isNull(evidenceItems.deletedAt),
            ),
          )
          .where(
            and(
              eq(personContactPoints.workspaceId, input.workspaceId),
              eq(personContactPoints.personId, input.personId),
              isNull(personContactPoints.deletedAt),
              input.evidenceVisibility,
              sql`${evidenceItems.fileId} IS NOT NULL`,
            ),
          ),
        database
          .select({ fileId: evidenceItems.fileId })
          .from(personAddresses)
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, input.workspaceId),
              eq(evidenceItems.id, personAddresses.evidenceId),
              isNull(evidenceItems.deletedAt),
            ),
          )
          .where(
            and(
              eq(personAddresses.workspaceId, input.workspaceId),
              eq(personAddresses.personId, input.personId),
              isNull(personAddresses.deletedAt),
              input.evidenceVisibility,
              sql`${evidenceItems.fileId} IS NOT NULL`,
            ),
          ),
      ]);

      const rolesByFile = new Map<string, Set<PersonFileRole>>();
      const addRefs = (
        refs: readonly { fileId: string | null }[],
        role: PersonFileRole,
      ) => {
        for (const ref of refs) {
          if (!ref.fileId) continue;
          const roles =
            rolesByFile.get(ref.fileId) ?? new Set<PersonFileRole>();
          roles.add(role);
          rolesByFile.set(ref.fileId, roles);
        }
      };
      addRefs(primaryPhotoRefs, "primary_photo");
      addRefs(factRefs, "fact");
      addRefs(factEvidenceRefs, "evidence");
      addRefs(relationshipEvidenceRefs, "evidence");
      addRefs(contactEvidenceRefs, "evidence");
      addRefs(addressEvidenceRefs, "evidence");
      const fileIds = [...rolesByFile.keys()];
      if (fileIds.length === 0) return [];

      const rows = await database
        .select(getTableColumns(files))
        .from(files)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.personId),
            isNull(people.deletedAt),
            input.personVisibility,
          ),
        )
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            inArray(files.id, fileIds),
            isNull(files.deletedAt),
            input.visibility,
            input.cursor
              ? or(
                  lt(files.createdAt, input.cursor.createdAt),
                  and(
                    eq(files.createdAt, input.cursor.createdAt),
                    lt(files.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(files.createdAt), desc(files.id))
        .limit(input.limit);

      return rows.map((row) => ({
        ...row,
        roles: [...(rolesByFile.get(row.id) ?? [])].sort(),
      }));
    },

    async create(input: {
      workspaceId: string;
      value: Omit<NewPersonRow, "workspaceId">;
    }): Promise<PersonRow> {
      const [row] = await database
        .insert(people)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Person insert did not return a row");
      return row;
    },

    async updateIfVersion(input: {
      workspaceId: string;
      id: string;
      expectedVersion: number;
      patch: Partial<NewPersonRow>;
    }): Promise<PersonRow | null> {
      const [row] = await database
        .update(people)
        .set({ ...input.patch, version: sql`${people.version} + 1` })
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.id),
            isNull(people.deletedAt),
            eq(people.version, input.expectedVersion),
          ),
        )
        .returning();
      return row ?? null;
    },
  };
}
