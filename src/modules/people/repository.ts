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
  sources,
} from "@/db/schema/evidence";
import { relationshipEvidence } from "@/db/schema/evidence";
import { relationships } from "@/db/schema/relationships";
import { addresses, contactPoints } from "@/db/schema/locations";
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
      sourceVisibility?: SQL;
      relationshipVisibility?: SQL;
      contactVisibility?: SQL;
      addressVisibility?: SQL;
      contactResourceVisibility?: SQL;
      addressResourceVisibility?: SQL;
    }): Promise<PersonFileRow[]> {
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
            sql`(
              ${files.id} = ${people.primaryPhotoFileId}
              OR EXISTS (
                SELECT 1 FROM ${facts}
                WHERE ${facts.workspaceId} = ${input.workspaceId}::uuid
                  AND ${facts.personId} = ${input.personId}::uuid
                  AND ${facts.fileId} = ${files.id}
                  AND ${facts.deletedAt} IS NULL
                  AND ${input.factVisibility}
              )
              OR EXISTS (
                SELECT 1 FROM ${factEvidence}
                INNER JOIN ${facts} ON ${facts.workspaceId} = ${factEvidence.workspaceId}
                  AND ${facts.id} = ${factEvidence.factId}
                INNER JOIN ${evidenceItems} ON ${evidenceItems.workspaceId} = ${factEvidence.workspaceId}
                  AND ${evidenceItems.id} = ${factEvidence.evidenceItemId}
                INNER JOIN ${sources} ON ${sources.workspaceId} = ${evidenceItems.workspaceId}
                  AND ${sources.id} = ${evidenceItems.sourceId}
                WHERE ${factEvidence.workspaceId} = ${input.workspaceId}::uuid
                  AND ${facts.personId} = ${input.personId}::uuid
                  AND ${evidenceItems.fileId} = ${files.id}
                  AND ${facts.deletedAt} IS NULL
                  AND ${evidenceItems.deletedAt} IS NULL
                  AND ${input.factVisibility}
                  AND ${input.evidenceVisibility}
                  AND ${input.sourceVisibility}
              )
              OR EXISTS (
                SELECT 1 FROM ${relationshipEvidence}
                INNER JOIN ${relationships} ON ${relationships.workspaceId} = ${relationshipEvidence.workspaceId}
                  AND ${relationships.id} = ${relationshipEvidence.relationshipId}
                INNER JOIN ${evidenceItems} ON ${evidenceItems.workspaceId} = ${relationshipEvidence.workspaceId}
                  AND ${evidenceItems.id} = ${relationshipEvidence.evidenceItemId}
                INNER JOIN ${sources} ON ${sources.workspaceId} = ${evidenceItems.workspaceId}
                  AND ${sources.id} = ${evidenceItems.sourceId}
                WHERE ${relationshipEvidence.workspaceId} = ${input.workspaceId}::uuid
                  AND (${relationships.sourcePersonId} = ${input.personId}::uuid OR ${relationships.targetPersonId} = ${input.personId}::uuid)
                  AND ${evidenceItems.fileId} = ${files.id}
                  AND ${relationships.deletedAt} IS NULL
                  AND ${evidenceItems.deletedAt} IS NULL
                  AND ${input.relationshipVisibility}
                  AND ${input.evidenceVisibility}
                  AND ${input.sourceVisibility}
              )
              OR EXISTS (
                SELECT 1 FROM ${personContactPoints}
                INNER JOIN ${contactPoints} ON ${contactPoints.workspaceId} = ${personContactPoints.workspaceId}
                  AND ${contactPoints.id} = ${personContactPoints.contactPointId}
                INNER JOIN ${evidenceItems} ON ${evidenceItems.workspaceId} = ${personContactPoints.workspaceId}
                  AND ${evidenceItems.id} = ${personContactPoints.evidenceId}
                INNER JOIN ${sources} ON ${sources.workspaceId} = ${evidenceItems.workspaceId}
                  AND ${sources.id} = ${evidenceItems.sourceId}
                WHERE ${personContactPoints.workspaceId} = ${input.workspaceId}::uuid
                  AND ${personContactPoints.personId} = ${input.personId}::uuid
                  AND ${evidenceItems.fileId} = ${files.id}
                  AND ${personContactPoints.deletedAt} IS NULL
                  AND ${evidenceItems.deletedAt} IS NULL
                  AND ${input.contactVisibility}
                  AND ${input.contactResourceVisibility}
                  AND ${input.evidenceVisibility}
                  AND ${input.sourceVisibility}
              )
              OR EXISTS (
                SELECT 1 FROM ${personAddresses}
                INNER JOIN ${addresses} ON ${addresses.workspaceId} = ${personAddresses.workspaceId}
                  AND ${addresses.id} = ${personAddresses.addressId}
                INNER JOIN ${evidenceItems} ON ${evidenceItems.workspaceId} = ${personAddresses.workspaceId}
                  AND ${evidenceItems.id} = ${personAddresses.evidenceId}
                INNER JOIN ${sources} ON ${sources.workspaceId} = ${evidenceItems.workspaceId}
                  AND ${sources.id} = ${evidenceItems.sourceId}
                WHERE ${personAddresses.workspaceId} = ${input.workspaceId}::uuid
                  AND ${personAddresses.personId} = ${input.personId}::uuid
                  AND ${evidenceItems.fileId} = ${files.id}
                  AND ${personAddresses.deletedAt} IS NULL
                  AND ${evidenceItems.deletedAt} IS NULL
                  AND ${input.addressVisibility}
                  AND ${input.addressResourceVisibility}
                  AND ${input.evidenceVisibility}
                  AND ${input.sourceVisibility}
              )
            )`,
          ),
        )
        .orderBy(desc(files.createdAt), desc(files.id))
        .limit(input.limit);
      if (rows.length === 0) return [];
      const fileIds = rows.map((row) => row.id);
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
              inArray(people.primaryPhotoFileId, fileIds),
            ),
          ),
        database
          .select({ fileId: facts.fileId })
          .from(facts)
          .where(
            and(
              eq(facts.workspaceId, input.workspaceId),
              eq(facts.personId, input.personId),
              isNull(facts.deletedAt),
              input.factVisibility,
              inArray(facts.fileId, fileIds),
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
          .innerJoin(
            sources,
            and(
              eq(sources.workspaceId, input.workspaceId),
              eq(sources.id, evidenceItems.sourceId),
              input.sourceVisibility,
            ),
          )
          .where(
            and(
              eq(factEvidence.workspaceId, input.workspaceId),
              inArray(evidenceItems.fileId, fileIds),
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
          .innerJoin(
            sources,
            and(
              eq(sources.workspaceId, input.workspaceId),
              eq(sources.id, evidenceItems.sourceId),
              input.sourceVisibility,
            ),
          )
          .where(
            and(
              eq(relationshipEvidence.workspaceId, input.workspaceId),
              inArray(evidenceItems.fileId, fileIds),
            ),
          ),
        database
          .select({ fileId: evidenceItems.fileId })
          .from(personContactPoints)
          .innerJoin(
            contactPoints,
            and(
              eq(contactPoints.workspaceId, input.workspaceId),
              eq(contactPoints.id, personContactPoints.contactPointId),
              input.contactResourceVisibility,
            ),
          )
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, input.workspaceId),
              eq(evidenceItems.id, personContactPoints.evidenceId),
              isNull(evidenceItems.deletedAt),
            ),
          )
          .innerJoin(
            sources,
            and(
              eq(sources.workspaceId, input.workspaceId),
              eq(sources.id, evidenceItems.sourceId),
              input.sourceVisibility,
            ),
          )
          .where(
            and(
              eq(personContactPoints.workspaceId, input.workspaceId),
              eq(personContactPoints.personId, input.personId),
              isNull(personContactPoints.deletedAt),
              input.contactVisibility,
              input.evidenceVisibility,
              inArray(evidenceItems.fileId, fileIds),
            ),
          ),
        database
          .select({ fileId: evidenceItems.fileId })
          .from(personAddresses)
          .innerJoin(
            addresses,
            and(
              eq(addresses.workspaceId, input.workspaceId),
              eq(addresses.id, personAddresses.addressId),
              input.addressResourceVisibility,
            ),
          )
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, input.workspaceId),
              eq(evidenceItems.id, personAddresses.evidenceId),
              isNull(evidenceItems.deletedAt),
            ),
          )
          .innerJoin(
            sources,
            and(
              eq(sources.workspaceId, input.workspaceId),
              eq(sources.id, evidenceItems.sourceId),
              input.sourceVisibility,
            ),
          )
          .where(
            and(
              eq(personAddresses.workspaceId, input.workspaceId),
              eq(personAddresses.personId, input.personId),
              isNull(personAddresses.deletedAt),
              input.addressVisibility,
              input.evidenceVisibility,
              inArray(evidenceItems.fileId, fileIds),
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
