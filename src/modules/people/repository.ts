import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { people } from "@/db/schema/people";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type PersonRow = typeof people.$inferSelect;
export type NewPersonRow = typeof people.$inferInsert;

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
