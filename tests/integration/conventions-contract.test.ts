// @vitest-environment node

import { and, eq, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import * as schema from "@/db/schema";
import { createFilesRepository } from "@/modules/files/repository";
import { createPeopleRepository } from "@/modules/people/repository";
import {
  createTestConnection,
  resetTestDatabase,
  type TestDatabase,
} from "../support/auth";

const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const foreignKey = (
  table: Parameters<typeof getTableConfig>[0],
  name: string,
) => {
  const constraint = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (!constraint) throw new Error(`Missing foreign key ${name}`);
  const reference = constraint.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    foreignTable: getTableName(reference.foreignTable),
  };
};

describe("HUM-NFR-003 representative source conventions", () => {
  it("generates UUIDv7 identifiers that retain generation order", () => {
    const ids = Array.from({ length: 32 }, () => newId());

    for (const id of ids) expect(id).toMatch(uuidV7);
    expect([...ids].sort()).toEqual(ids);
  });

  it("declares workspace-leading same-workspace references across people, facts, locations, files, and relationships", () => {
    expect(foreignKey(schema.facts, "facts_workspace_person_fk")).toEqual({
      columns: ["workspace_id", "person_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: "people",
    });
    expect(foreignKey(schema.facts, "facts_workspace_place_fk")).toEqual({
      columns: ["workspace_id", "place_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: "places",
    });
    expect(foreignKey(schema.facts, "facts_workspace_file_fk")).toEqual({
      columns: ["workspace_id", "file_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: "files",
    });
    expect(
      foreignKey(
        schema.relationships,
        "relationships_workspace_source_person_fk",
      ),
    ).toEqual({
      columns: ["workspace_id", "source_person_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: "people",
    });
    expect(
      foreignKey(schema.fileVariants, "file_variants_workspace_parent_file_fk"),
    ).toEqual({
      columns: ["workspace_id", "parent_file_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: "files",
    });
  });

  it("declares UTC metadata, actors, versions, and soft deletion on representative mutable records", () => {
    for (const table of [
      schema.people,
      schema.facts,
      schema.places,
      schema.files,
      schema.relationships,
    ]) {
      const columns = table as unknown as Record<
        string,
        { notNull?: boolean; withTimezone?: boolean }
      >;
      expect(columns.workspaceId.notNull).toBe(true);
      expect(columns.version.notNull).toBe(true);
      expect(columns.createdAt).toMatchObject({
        notNull: true,
        withTimezone: true,
      });
      expect(columns.updatedAt).toMatchObject({
        notNull: true,
        withTimezone: true,
      });
      expect(columns.deletedAt.withTimezone).toBe(true);
      expect(columns.createdBy.notNull).toBe(true);
      expect(columns.updatedBy.notNull).toBe(true);
    }
  });
});

liveDescribe("HUM-NFR-003 representative PostgreSQL conventions", () => {
  const connection = process.env.TEST_DATABASE_URL
    ? createTestConnection(1)
    : undefined;
  const database = connection
    ? (drizzle(connection, { schema }) as TestDatabase)
    : undefined;
  const peopleRepository = database
    ? createPeopleRepository(database)
    : undefined;
  const filesRepository = database
    ? createFilesRepository(database)
    : undefined;
  const userId = `user-${newId()}`;
  const organizationA = `org-${newId()}`;
  const organizationB = `org-${newId()}`;
  const workspaceA = newId();
  const workspaceB = newId();
  const personA = newId();
  const personB = newId();
  const fileA = newId();
  const relationshipTypeA = newId();

  beforeAll(async () => {
    await resetTestDatabase(connection!);
    await connection!`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Convention user', ${`${newId()}@example.test`}, true, now(), now())
    `;
    for (const [organizationId, workspaceId, label] of [
      [organizationA, workspaceA, "A"],
      [organizationB, workspaceB, "B"],
    ] as const) {
      await connection!`
        INSERT INTO organizations (id, name, slug, created_at)
        VALUES (${organizationId}, ${`Organization ${label}`}, ${`org-${label}-${newId()}`}, now())
      `;
      await connection!`
        INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
        VALUES (${workspaceId}, ${organizationId}, ${`Workspace ${label}`}, ${userId}, ${userId})
      `;
    }
    await connection!`
      INSERT INTO workspace_principals (id, workspace_id, principal_type, user_id)
      VALUES (${newId()}, ${workspaceA}, 'user', ${userId})
    `;
    await connection!`
      INSERT INTO people (id, workspace_id, display_name, created_by, updated_by)
      VALUES
        (${personA}, ${workspaceA}, 'Person A', ${userId}, ${userId}),
        (${personB}, ${workspaceB}, 'Person B', ${userId}, ${userId})
    `;
    await connection!`
      INSERT INTO relationship_types (
        id, workspace_id, namespace, key, forward_label, inverse_label,
        created_by, updated_by
      ) VALUES (
        ${relationshipTypeA}, ${workspaceA}, 'workspace', 'knows', 'knows',
        'known by', ${userId}, ${userId}
      )
    `;
    await connection!`
      INSERT INTO files (
        id, workspace_id, storage_provider, storage_bucket, storage_key,
        original_name, byte_size, checksum, uploaded_by, created_by, updated_by
      ) VALUES (
        ${fileA}, ${workspaceA}, 'test', 'test', ${`files/${fileA}`},
        'convention.txt', 1, ${`sha256:${fileA}`}, ${userId}, ${userId}, ${userId}
      )
    `;
  }, 120_000);

  afterAll(async () => connection?.end());

  it("rejects cross-workspace references and records timestamp columns as timestamptz", async () => {
    await expect(
      connection!`
        INSERT INTO relationships (
          id, workspace_id, source_person_id, target_person_id, relationship_type_id,
          created_by, updated_by
        ) VALUES (
          ${newId()}, ${workspaceA}, ${personA}, ${personB}, ${relationshipTypeA},
          ${userId}, ${userId}
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });

    const columns = await connection!<
      { column_name: string; data_type: string }[]
    >`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('people', 'facts', 'places', 'files', 'relationships')
        AND column_name IN ('created_at', 'updated_at', 'deleted_at')
      ORDER BY table_name, column_name
    `;
    expect(columns).toHaveLength(15);
    expect(
      columns.every(
        (column) => column.data_type === "timestamp with time zone",
      ),
    ).toBe(true);
  });

  it("rejects stale optimistic writes and hides archived rows from current repositories", async () => {
    const updated = await peopleRepository!.updateIfVersion({
      workspaceId: workspaceA,
      id: personA,
      expectedVersion: 1,
      patch: { displayName: "Person A updated", updatedBy: userId },
    });
    expect(updated).toMatchObject({ id: personA, version: 2 });
    await expect(
      peopleRepository!.updateIfVersion({
        workspaceId: workspaceA,
        id: personA,
        expectedVersion: 1,
        patch: { displayName: "stale", updatedBy: userId },
      }),
    ).resolves.toBeNull();

    const archived = await filesRepository!.archiveFile({
      workspaceId: workspaceA,
      id: fileA,
      expectedVersion: 1,
      deletedAt: new Date("2026-08-05T00:00:00.000Z"),
      deletedBy: userId,
    });
    expect(archived).toMatchObject({
      id: fileA,
      version: 2,
      deletedBy: userId,
    });
    expect(archived?.deletedAt).toBeInstanceOf(Date);
    await expect(
      filesRepository!.getFile({ id: fileA, workspaceId: workspaceA }),
    ).resolves.toBeNull();
    const [stored] = await database!
      .select({ deletedAt: schema.files.deletedAt })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.workspaceId, workspaceA),
          eq(schema.files.id, fileA),
        ),
      );
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });
});
