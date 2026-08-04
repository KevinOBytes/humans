import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { fileVariants, files, uploadSessions } from "@/db/schema/files";
import { newId } from "@/db/id";
import { workspaceSettings, workspaceUsage } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type UploadSessionRow = typeof uploadSessions.$inferSelect;
export type NewUploadSessionRow = typeof uploadSessions.$inferInsert;
export type FileObjectLocation = {
  storageBucket: string;
  storageKey: string;
  storageProvider: string;
};

export function createFilesRepository(database: Database) {
  return {
    async isStorageEnabled(workspaceId: string): Promise<boolean> {
      const [row] = await database
        .select({ enabled: workspaceSettings.storageEnabled })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId))
        .limit(1);
      return row?.enabled === true;
    },

    async countPending(input: {
      actorId?: string;
      workspaceId: string;
      now: Date;
    }): Promise<number> {
      const [row] = await database
        .select({ count: sql<number>`count(*)::integer` })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, input.workspaceId),
            input.actorId
              ? eq(uploadSessions.actorId, input.actorId)
              : undefined,
            inArray(uploadSessions.state, ["pending", "verifying"]),
            gt(uploadSessions.expiresAt, sql`clock_timestamp()`),
          ),
        );
      return row?.count ?? 0;
    },

    async serializeUploadCapacity(workspaceId: string): Promise<void> {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 884211))`,
      );
    },

    async createSession(input: NewUploadSessionRow): Promise<UploadSessionRow> {
      const [row] = await database
        .insert(uploadSessions)
        .values(input)
        .returning();
      if (!row) throw new Error("Upload session insert did not return a row");
      return row;
    },

    async getSession(input: {
      id: string;
      workspaceId: string;
    }): Promise<UploadSessionRow | null> {
      const [row] = await database
        .select()
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, input.workspaceId),
            eq(uploadSessions.id, input.id),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async lockSession(input: {
      id: string;
      workspaceId: string;
    }): Promise<UploadSessionRow | null> {
      const [row] = await database
        .select()
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, input.workspaceId),
            eq(uploadSessions.id, input.id),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async setSessionState(input: {
      id: string;
      workspaceId: string;
      from: readonly string[];
      state: string;
      failureCode?: string | null;
      fileId?: string | null;
      completedAt?: Date | null;
      updatedAt: Date;
      updatedBy: string;
    }): Promise<UploadSessionRow | null> {
      const [row] = await database
        .update(uploadSessions)
        .set({
          state: input.state,
          failureCode: input.failureCode,
          fileId: input.fileId,
          completedAt: input.completedAt,
          updatedAt: input.updatedAt,
          updatedBy: input.updatedBy,
        })
        .where(
          and(
            eq(uploadSessions.workspaceId, input.workspaceId),
            eq(uploadSessions.id, input.id),
            inArray(uploadSessions.state, [...input.from]),
          ),
        )
        .returning();
      return row ?? null;
    },

    async createFile(input: NewFileRow): Promise<FileRow> {
      const [row] = await database.insert(files).values(input).returning();
      if (!row) throw new Error("File insert did not return a row");
      return row;
    },

    async lockFileForArchive(input: {
      id: string;
      workspaceId: string;
      visibility: SQL;
    }): Promise<FileRow | null> {
      const [row] = await database
        .select()
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.id),
            isNull(files.deletedAt),
            input.visibility,
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async archiveFile(input: {
      id: string;
      workspaceId: string;
      expectedVersion: number;
      deletedAt: Date;
      deletedBy: string;
    }): Promise<FileRow | null> {
      const [row] = await database
        .update(files)
        .set({
          deletedAt: input.deletedAt,
          deletedBy: input.deletedBy,
          updatedAt: input.deletedAt,
          updatedBy: input.deletedBy,
          version: sql`${files.version} + 1`,
        })
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.id),
            isNull(files.deletedAt),
            eq(files.version, input.expectedVersion),
          ),
        )
        .returning();
      return row ?? null;
    },

    async lockArchivedFileObjectKeys(input: {
      id: string;
      workspaceId: string;
    }): Promise<readonly FileObjectLocation[] | null> {
      const [file] = await database
        .select({
          storageBucket: files.storageBucket,
          storageKey: files.storageKey,
          storageProvider: files.storageProvider,
        })
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.id),
            isNotNull(files.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!file) return null;
      const variants = await database
        .select({
          storageBucket: fileVariants.storageBucket,
          storageKey: fileVariants.storageKey,
          storageProvider: fileVariants.storageProvider,
        })
        .from(fileVariants)
        .where(
          and(
            eq(fileVariants.workspaceId, input.workspaceId),
            eq(fileVariants.parentFileId, input.id),
          ),
        )
        .orderBy(fileVariants.id)
        .for("update");
      return [file, ...variants];
    },

    async getCompletedSessionForFile(input: {
      fileId: string;
      workspaceId: string;
    }): Promise<UploadSessionRow | null> {
      const [row] = await database
        .select()
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, input.workspaceId),
            eq(uploadSessions.fileId, input.fileId),
            eq(uploadSessions.state, "completed"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async updateScan(input: {
      id: string;
      workspaceId: string;
      quarantineState: "available" | "quarantined" | "rejected";
      scanState: "clean" | "not_required" | "infected" | "error";
      updatedAt: Date;
      updatedBy: string;
    }): Promise<FileRow | null> {
      const [row] = await database
        .update(files)
        .set({
          quarantineState: input.quarantineState,
          scanState: input.scanState,
          updatedAt: input.updatedAt,
          updatedBy: input.updatedBy,
          version: sql`${files.version} + 1`,
        })
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.id),
            isNull(files.deletedAt),
            eq(files.quarantineState, "quarantined"),
          ),
        )
        .returning();
      return row ?? null;
    },

    async getFile(input: {
      id: string;
      workspaceId: string;
      visibility?: SQL;
    }): Promise<FileRow | null> {
      const [row] = await database
        .select()
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.id),
            isNull(files.deletedAt),
            input.visibility,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getFiles(input: {
      ids: readonly string[];
      workspaceId: string;
      visibility?: SQL;
    }): Promise<FileRow[]> {
      if (input.ids.length === 0) return [];
      return database
        .select()
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            inArray(files.id, [...input.ids]),
            isNull(files.deletedAt),
            input.visibility,
          ),
        );
    },

    async listFiles(input: {
      workspaceId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
      availability?: string | null;
      visibility?: SQL;
    }): Promise<FileRow[]> {
      return database
        .select()
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            isNull(files.deletedAt),
            input.visibility,
            input.availability
              ? eq(files.quarantineState, input.availability)
              : undefined,
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
    },

    async addStorageUsage(input: {
      workspaceId: string;
      byteSize: number;
      now: Date;
      actorId: string;
    }): Promise<void> {
      const usageDate = input.now.toISOString().slice(0, 10);
      await database
        .insert(workspaceUsage)
        .values({
          id: newId(),
          workspaceId: input.workspaceId,
          usageDate,
          storageBytes: String(input.byteSize),
          createdAt: input.now,
          updatedAt: input.now,
          createdBy: input.actorId,
          updatedBy: input.actorId,
        })
        .onConflictDoUpdate({
          target: [workspaceUsage.workspaceId, workspaceUsage.usageDate],
          set: {
            storageBytes: sql`(${workspaceUsage.storageBytes}::numeric + ${String(input.byteSize)}::numeric)::text`,
            updatedAt: input.now,
            updatedBy: input.actorId,
            version: sql`${workspaceUsage.version} + 1`,
          },
        });
    },

    async purposeForFile(input: {
      fileId: string;
      workspaceId: string;
    }): Promise<string | null> {
      const [row] = await database
        .select({ purpose: uploadSessions.intendedPurpose })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, input.workspaceId),
            eq(uploadSessions.fileId, input.fileId),
            eq(uploadSessions.state, "completed"),
          ),
        )
        .limit(1);
      return row?.purpose ?? null;
    },
  };
}

export type FilesRepository = ReturnType<typeof createFilesRepository>;
