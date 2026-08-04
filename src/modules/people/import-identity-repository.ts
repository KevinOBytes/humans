import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { importRows, imports } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { externalRecords, people, personNames } from "@/db/schema/people";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type ImportIdentityPerson = Pick<
  typeof people.$inferSelect,
  "displayName" | "id" | "primaryNameId" | "sensitivity" | "version"
>;
export type ImportIdentityName = typeof personNames.$inferSelect;
export type ImportIdentityExternalRecord = typeof externalRecords.$inferSelect;

export function createImportIdentityRepository(database: Database) {
  return {
    async lockRunningRelationshipImportRow(input: {
      importId: string;
      importRowId: string;
      workspaceId: string;
    }): Promise<{
      importMapping: unknown;
      normalizedPayload: unknown;
    } | null> {
      const rows = await database
        .select({
          importMapping: imports.mapping,
          normalizedPayload: importRows.normalizedPayload,
        })
        .from(imports)
        .innerJoin(
          importRows,
          and(
            eq(importRows.workspaceId, imports.workspaceId),
            eq(importRows.importId, imports.id),
            eq(importRows.id, input.importRowId),
          ),
        )
        .where(
          and(
            eq(imports.workspaceId, input.workspaceId),
            eq(imports.id, input.importId),
            eq(imports.state, "running"),
            eq(importRows.state, "processing"),
          ),
        )
        .limit(2)
        .for("update");
      return rows.length === 1 ? (rows[0] ?? null) : null;
    },

    async serializeExternalKey(input: {
      externalId: string;
      importId: string;
      workspaceId: string;
    }): Promise<void> {
      const key = `humans:import-identity:${input.workspaceId}:${input.importId}:${input.externalId}`;
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    },

    async lockPersonAndRunningImport(input: {
      importId: string;
      importRowId: string;
      personId: string;
      workspaceId: string;
    }): Promise<{
      importMapping: unknown;
      importRow: Pick<
        typeof importRows.$inferSelect,
        "normalizedPayload" | "sourceHash"
      >;
      person: ImportIdentityPerson;
    } | null> {
      const rows = await database
        .select({
          importMapping: imports.mapping,
          importRow: {
            normalizedPayload: importRows.normalizedPayload,
            sourceHash: importRows.sourceHash,
          },
          person: {
            displayName: people.displayName,
            id: people.id,
            primaryNameId: people.primaryNameId,
            sensitivity: people.sensitivity,
            version: people.version,
          },
        })
        .from(people)
        .innerJoin(
          imports,
          and(
            eq(imports.workspaceId, people.workspaceId),
            eq(imports.id, input.importId),
          ),
        )
        .innerJoin(
          importRows,
          and(
            eq(importRows.workspaceId, imports.workspaceId),
            eq(importRows.importId, imports.id),
            eq(importRows.id, input.importRowId),
          ),
        )
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.personId),
            isNull(people.deletedAt),
            eq(imports.state, "running"),
            eq(importRows.state, "processing"),
          ),
        )
        .limit(2)
        .for("update");
      return rows.length === 1 ? (rows[0] ?? null) : null;
    },

    async hasCurrentWorkerPersonCreation(input: {
      importId: string;
      importRowId: string;
      jobId: string;
      personId: string;
      requestId: string;
      workspaceId: string;
    }): Promise<boolean> {
      const rows = await database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, input.workspaceId),
            eq(auditEvents.action, "system.import.person.create"),
            eq(auditEvents.resourceKind, "person"),
            eq(auditEvents.resourceId, input.personId),
            eq(auditEvents.requestId, input.requestId),
            isNull(auditEvents.actorUserId),
            isNull(auditEvents.sessionId),
            isNull(auditEvents.apiKeyId),
            sql`${auditEvents.redactedDiff}->'worker'->>'importId' = ${input.importId}`,
            sql`${auditEvents.redactedDiff}->'worker'->>'importRowId' = ${input.importRowId}`,
            sql`${auditEvents.redactedDiff}->'worker'->>'jobId' = ${input.jobId}`,
          ),
        )
        .limit(2);
      return rows.length === 1;
    },

    async getExternalRecordForUpdate(input: {
      externalId: string;
      sourceSystem: string;
      workspaceId: string;
    }): Promise<ImportIdentityExternalRecord | null> {
      const [row] = await database
        .select()
        .from(externalRecords)
        .where(
          and(
            eq(externalRecords.workspaceId, input.workspaceId),
            eq(externalRecords.sourceSystem, input.sourceSystem),
            eq(externalRecords.externalType, "person"),
            eq(externalRecords.externalId, input.externalId),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async getPersonNameForUpdate(input: {
      id: string;
      personId: string;
      workspaceId: string;
    }): Promise<ImportIdentityName | null> {
      const [row] = await database
        .select()
        .from(personNames)
        .where(
          and(
            eq(personNames.workspaceId, input.workspaceId),
            eq(personNames.personId, input.personId),
            eq(personNames.id, input.id),
            isNull(personNames.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async insertPersonName(
      value: typeof personNames.$inferInsert,
    ): Promise<ImportIdentityName> {
      const [row] = await database
        .insert(personNames)
        .values(value)
        .returning();
      if (!row) throw new Error("Person-name insert did not return a row");
      return row;
    },

    async setPrimaryName(input: {
      expectedVersion: number;
      nameId: string;
      personId: string;
      principalId: string;
      updatedAt: Date;
      workspaceId: string;
    }): Promise<ImportIdentityPerson | null> {
      const [row] = await database
        .update(people)
        .set({
          primaryNameId: input.nameId,
          updatedAt: input.updatedAt,
          updatedBy: input.principalId,
          version: sql`${people.version} + 1`,
        })
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.personId),
            eq(people.version, input.expectedVersion),
            isNull(people.primaryNameId),
            isNull(people.deletedAt),
          ),
        )
        .returning({
          displayName: people.displayName,
          id: people.id,
          primaryNameId: people.primaryNameId,
          sensitivity: people.sensitivity,
          version: people.version,
        });
      return row ?? null;
    },

    async insertExternalRecord(
      value: typeof externalRecords.$inferInsert,
    ): Promise<ImportIdentityExternalRecord> {
      const [row] = await database
        .insert(externalRecords)
        .values(value)
        .returning();
      if (!row) throw new Error("External-record insert did not return a row");
      return row;
    },

    async resolveCompletedPersonExternalKey(input: {
      externalId: string;
      importId: string;
      sourceSystem: string;
      workspaceId: string;
    }): Promise<{
      importMapping: unknown;
      person: Pick<typeof people.$inferSelect, "id" | "sensitivity">;
    } | null> {
      const rows = await database
        .select({
          importMapping: imports.mapping,
          person: { id: people.id, sensitivity: people.sensitivity },
        })
        .from(externalRecords)
        .innerJoin(
          imports,
          and(
            eq(imports.workspaceId, externalRecords.workspaceId),
            eq(imports.id, externalRecords.importId),
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, externalRecords.workspaceId),
            eq(people.id, externalRecords.personId),
          ),
        )
        .where(
          and(
            eq(externalRecords.workspaceId, input.workspaceId),
            eq(externalRecords.importId, input.importId),
            eq(externalRecords.sourceSystem, input.sourceSystem),
            eq(externalRecords.externalType, "person"),
            eq(externalRecords.externalId, input.externalId),
            isNull(externalRecords.deletedAt),
            isNull(people.deletedAt),
            inArray(imports.state, ["completed", "completed_with_errors"]),
          ),
        )
        .limit(2)
        .for("share");
      return rows.length === 1 ? (rows[0] ?? null) : null;
    },

    async getPersonForShare(input: {
      personId: string;
      workspaceId: string;
    }): Promise<Pick<typeof people.$inferSelect, "id" | "sensitivity"> | null> {
      const rows = await database
        .select({ id: people.id, sensitivity: people.sensitivity })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            eq(people.id, input.personId),
            isNull(people.deletedAt),
          ),
        )
        .limit(2)
        .for("share");
      return rows.length === 1 ? (rows[0] ?? null) : null;
    },
  };
}
