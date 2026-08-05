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
import type { Database } from "@/modules/auth/bootstrap-admin";

export type PersonRow = typeof people.$inferSelect;
export type NewPersonRow = typeof people.$inferInsert;
export type PersonNameRow = typeof personNames.$inferSelect;
export type PersonEventRow = typeof personEvents.$inferSelect;

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
