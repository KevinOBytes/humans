import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  importMappings,
  importRows,
  imports as importsTable,
} from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import { newId } from "@/db/id";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type ImportRow = typeof importsTable.$inferSelect;
export type ImportMappingRow = typeof importMappings.$inferSelect;
export type ImportStagedRow = typeof importRows.$inferSelect;

export function createImportsRepository(database: Database) {
  return {
    async getMapping(input: { id: string; workspaceId: string }) {
      const [row] = await database
        .select()
        .from(importMappings)
        .where(
          and(
            eq(importMappings.workspaceId, input.workspaceId),
            eq(importMappings.id, input.id),
            isNull(importMappings.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getMappingsByIds(input: {
      ids: readonly string[];
      workspaceId: string;
    }): Promise<ImportMappingRow[]> {
      if (!input.ids.length) return [];
      return database
        .select()
        .from(importMappings)
        .where(
          and(
            eq(importMappings.workspaceId, input.workspaceId),
            inArray(importMappings.id, [...input.ids]),
            isNull(importMappings.deletedAt),
          ),
        );
    },

    async listMappings(input: {
      workspaceId: string;
      limit: number;
      cursor?: { createdAt: Date; id: string } | null;
    }): Promise<ImportMappingRow[]> {
      return database
        .select()
        .from(importMappings)
        .where(
          and(
            eq(importMappings.workspaceId, input.workspaceId),
            isNull(importMappings.deletedAt),
            input.cursor
              ? or(
                  lt(importMappings.createdAt, input.cursor.createdAt),
                  and(
                    eq(importMappings.createdAt, input.cursor.createdAt),
                    lt(importMappings.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(importMappings.createdAt), desc(importMappings.id))
        .limit(input.limit);
    },

    async createMapping(input: typeof importMappings.$inferInsert) {
      const [row] = await database
        .insert(importMappings)
        .values(input)
        .returning();
      if (!row) throw new Error("Import mapping insert failed");
      return row;
    },

    async updateMapping(input: {
      id: string;
      workspaceId: string;
      expectedVersion: number;
      name: string;
      format: string;
      definition: unknown;
      validationConfig: unknown;
      now: Date;
      actorId: string;
    }) {
      const [row] = await database
        .update(importMappings)
        .set({
          name: input.name,
          format: input.format,
          columnMapping: input.definition,
          validationConfig: input.validationConfig,
          updatedAt: input.now,
          updatedBy: input.actorId,
          version: sql`${importMappings.version} + 1`,
        })
        .where(
          and(
            eq(importMappings.workspaceId, input.workspaceId),
            eq(importMappings.id, input.id),
            eq(importMappings.version, input.expectedVersion),
            isNull(importMappings.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },

    async getImport(input: { id: string; workspaceId: string }) {
      const [row] = await database
        .select()
        .from(importsTable)
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            eq(importsTable.id, input.id),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getImportsByIds(input: {
      ids: readonly string[];
      workspaceId: string;
    }): Promise<ImportRow[]> {
      if (!input.ids.length) return [];
      return database
        .select()
        .from(importsTable)
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            inArray(importsTable.id, [...input.ids]),
          ),
        );
    },

    async getByIdempotency(input: {
      idempotencyKey: string;
      workspaceId: string;
    }) {
      const [row] = await database
        .select()
        .from(importsTable)
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            eq(importsTable.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listImports(input: {
      workspaceId: string;
      limit: number;
      state?: string | null;
      cursor?: { createdAt: Date; id: string } | null;
    }): Promise<ImportRow[]> {
      return database
        .select()
        .from(importsTable)
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            input.state ? eq(importsTable.state, input.state) : undefined,
            input.cursor
              ? or(
                  lt(importsTable.createdAt, input.cursor.createdAt),
                  and(
                    eq(importsTable.createdAt, input.cursor.createdAt),
                    lt(importsTable.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(importsTable.createdAt), desc(importsTable.id))
        .limit(input.limit);
    },

    async createImport(input: typeof importsTable.$inferInsert) {
      const [row] = await database
        .insert(importsTable)
        .values(input)
        .returning();
      if (!row) throw new Error("Import insert failed");
      return row;
    },

    async claimPrepare(input: {
      actorId: string;
      envelope: unknown;
      fileId: string;
      format: string;
      id: string;
      idempotencyKey: string;
      leaseMs: number;
      owner: string;
      requestHash: string;
      workspaceId: string;
    }) {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`humans:prepare:${input.workspaceId}:${input.idempotencyKey}`}, 941107))`,
        );
        let [row] = await transaction
          .select()
          .from(importsTable)
          .where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
          .for("update");
        let created = false;
        if (!row) {
          [row] = await transaction
            .insert(importsTable)
            .values({
              id: input.id,
              workspaceId: input.workspaceId,
              fileId: input.fileId,
              format: input.format,
              state: "staging",
              mapping: input.envelope,
              idempotencyKey: input.idempotencyKey,
              stagingGeneration: 1,
              stagingOwner: input.owner,
              stagingLeaseExpiresAt: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
              createdBy: input.actorId,
              updatedBy: input.actorId,
            })
            .returning();
          if (!row) throw new Error("Import staging claim failed");
          created = true;
        }
        if (row.state === "preview_ready") {
          if (
            (row.mapping as { requestHash?: unknown } | null)?.requestHash !==
            input.requestHash
          ) {
            return { status: "conflict" as const, import: row, created };
          }
          return { status: "replay" as const, import: row, created };
        }
        if (
          (row.mapping as { requestHash?: unknown } | null)?.requestHash !==
          input.requestHash
        ) {
          return { status: "conflict" as const, import: row, created };
        }
        if (row.state !== "staging") {
          return { status: "conflict" as const, import: row, created };
        }
        if (!created) {
          const [claimed] = await transaction
            .update(importsTable)
            .set({
              stagingGeneration: sql`${importsTable.stagingGeneration} + 1`,
              stagingOwner: input.owner,
              stagingLeaseExpiresAt: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
              updatedAt: sql`clock_timestamp()`,
              updatedBy: input.actorId,
            })
            .where(
              and(
                eq(importsTable.workspaceId, input.workspaceId),
                eq(importsTable.id, row.id),
                eq(importsTable.state, "staging"),
                or(
                  isNull(importsTable.stagingOwner),
                  lte(
                    importsTable.stagingLeaseExpiresAt,
                    sql`clock_timestamp()`,
                  ),
                ),
              ),
            )
            .returning();
          if (!claimed)
            return { status: "wait" as const, import: row, created };
          row = claimed;
        }
        return {
          status: "claimed" as const,
          import: row,
          created,
          generation: row.stagingGeneration,
        };
      });
    },

    async insertPrepareRows(input: {
      generation: number;
      importId: string;
      leaseMs: number;
      owner: string;
      values: Array<typeof importRows.$inferInsert>;
      workspaceId: string;
    }): Promise<boolean> {
      if (!input.values.length) return true;
      return database.transaction(async (transaction) => {
        const [renewed] = await transaction
          .update(importsTable)
          .set({
            stagingLeaseExpiresAt: sql<Date>`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.id, input.importId),
              eq(importsTable.state, "staging"),
              eq(importsTable.stagingGeneration, input.generation),
              eq(importsTable.stagingOwner, input.owner),
              gt(importsTable.stagingLeaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ id: importsTable.id });
        if (!renewed) return false;
        await transaction.insert(importRows).values(input.values);
        return true;
      });
    },

    async failPrepare(input: {
      actorId: string;
      generation: number;
      importId: string;
      owner: string;
      workspaceId: string;
    }): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const [locked] = await transaction
          .select({ id: importsTable.id })
          .from(importsTable)
          .where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.id, input.importId),
              eq(importsTable.state, "staging"),
              eq(importsTable.stagingGeneration, input.generation),
              eq(importsTable.stagingOwner, input.owner),
            ),
          )
          .limit(1)
          .for("update");
        if (!locked) return false;
        await transaction
          .delete(importRows)
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.importId),
              eq(importRows.stagingGeneration, input.generation),
            ),
          );
        const [failed] = await transaction
          .update(importsTable)
          .set({
            state: "failed",
            stagingOwner: null,
            stagingLeaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
            updatedBy: input.actorId,
            version: sql`${importsTable.version} + 1`,
          })
          .where(eq(importsTable.id, input.importId))
          .returning({ id: importsTable.id });
        return Boolean(failed);
      });
    },

    async finishPrepare(input: {
      actorId: string;
      generation: number;
      importId: string;
      mapping: unknown;
      owner: string;
      rejectedRows: number;
      totalRows: number;
      workspaceId: string;
    }) {
      return database.transaction(async (transaction) => {
        const [locked] = await transaction
          .select()
          .from(importsTable)
          .where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.id, input.importId),
              eq(importsTable.state, "staging"),
              eq(importsTable.stagingGeneration, input.generation),
              eq(importsTable.stagingOwner, input.owner),
              gt(importsTable.stagingLeaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .limit(1)
          .for("update");
        if (!locked) return null;
        const [count] = await transaction
          .select({ count: sql<number>`count(*)::integer` })
          .from(importRows)
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.importId),
              eq(importRows.stagingGeneration, input.generation),
            ),
          );
        if ((count?.count ?? 0) !== input.totalRows) return null;
        await transaction
          .delete(importRows)
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.importId),
              lt(importRows.stagingGeneration, input.generation),
            ),
          );
        const [prepared] = await transaction
          .update(importsTable)
          .set({
            mapping: input.mapping,
            totalRows: input.totalRows,
            rejectedRows: input.rejectedRows,
            state: "preview_ready",
            stagingOwner: null,
            stagingLeaseExpiresAt: null,
            updatedAt: sql`clock_timestamp()`,
            updatedBy: input.actorId,
            version: sql`${importsTable.version} + 1`,
          })
          .where(
            and(
              eq(importsTable.id, input.importId),
              eq(importsTable.stagingGeneration, input.generation),
              eq(importsTable.stagingOwner, input.owner),
            ),
          )
          .returning();
        return prepared ?? null;
      });
    },

    async lockImport(input: { id: string; workspaceId: string }) {
      const [row] = await database
        .select()
        .from(importsTable)
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            eq(importsTable.id, input.id),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },

    async markPrepared(input: {
      id: string;
      workspaceId: string;
      mapping: unknown;
      totalRows: number;
      now: Date;
      actorId: string;
    }) {
      const [row] = await database
        .update(importsTable)
        .set({
          mapping: input.mapping,
          totalRows: input.totalRows,
          state: "preview_ready",
          updatedAt: input.now,
          updatedBy: input.actorId,
          version: sql`${importsTable.version} + 1`,
        })
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            eq(importsTable.id, input.id),
            eq(importsTable.state, "staging"),
          ),
        )
        .returning();
      return row ?? null;
    },

    async transitionImport(input: {
      acceptedRows?: number;
      id: string;
      workspaceId: string;
      expectedVersion?: number;
      from: readonly string[];
      state: string;
      now: Date;
      actorId?: string | null;
      completedAt?: Date | null;
      executionJobId?: string | null;
      rejectedRows?: number;
      startedAt?: Date | null;
    }) {
      const [row] = await database
        .update(importsTable)
        .set({
          state: input.state,
          acceptedRows: input.acceptedRows,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          executionJobId: input.executionJobId,
          rejectedRows: input.rejectedRows,
          updatedAt: input.now,
          ...(input.actorId ? { updatedBy: input.actorId } : {}),
          version: sql`${importsTable.version} + 1`,
        })
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            eq(importsTable.id, input.id),
            input.expectedVersion
              ? eq(importsTable.version, input.expectedVersion)
              : undefined,
            inArray(importsTable.state, [...input.from]),
          ),
        )
        .returning();
      return row ?? null;
    },

    async insertRows(values: Array<typeof importRows.$inferInsert>) {
      if (!values.length) return [];
      return database.insert(importRows).values(values).returning();
    },

    async deleteRows(input: { importId: string; workspaceId: string }) {
      await database
        .delete(importRows)
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.importId),
          ),
        );
    },

    async resetExecutionRowsForRetry(input: {
      actorId: string;
      importId: string;
      includeProcessing: boolean;
      now: Date;
      workspaceId: string;
    }) {
      const reset = await database
        .update(importRows)
        .set({
          state: "pending",
          resultReferences: [],
          validationErrors: [],
          updatedAt: input.now,
          updatedBy: input.actorId,
        })
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.importId),
            or(
              and(
                eq(importRows.state, "rejected"),
                sql`${importRows.normalizedPayload}->>'kind' in ('PERSON', 'RELATIONSHIP')`,
              ),
              input.includeProcessing
                ? eq(importRows.state, "processing")
                : undefined,
            ),
          ),
        )
        .returning({ id: importRows.id });
      const totals = await database
        .select({
          state: importRows.state,
          count: sql<number>`count(*)::integer`,
        })
        .from(importRows)
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.importId),
          ),
        )
        .groupBy(importRows.state);
      return {
        byState: new Map(totals.map((row) => [row.state, row.count])),
        resetCount: reset.length,
      };
    },

    async listRows(input: {
      importId: string;
      stagingGeneration: number;
      workspaceId: string;
      limit: number;
      cursor?: { rowNumber: number; id: string } | null;
    }): Promise<ImportStagedRow[]> {
      return database
        .select()
        .from(importRows)
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.importId),
            eq(importRows.stagingGeneration, input.stagingGeneration),
            input.cursor
              ? or(
                  gt(importRows.rowNumber, input.cursor.rowNumber),
                  and(
                    eq(importRows.rowNumber, input.cursor.rowNumber),
                    gt(importRows.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(importRows.rowNumber), asc(importRows.id))
        .limit(input.limit);
    },

    async countActive(input: { actorId?: string; workspaceId: string }) {
      const query = database
        .select({ count: sql<number>`count(*)::integer` })
        .from(importsTable);
      const [row] = input.actorId
        ? await query
            .innerJoin(
              jobs,
              and(
                eq(jobs.workspaceId, importsTable.workspaceId),
                eq(jobs.id, importsTable.executionJobId),
              ),
            )
            .where(
              and(
                eq(importsTable.workspaceId, input.workspaceId),
                eq(jobs.createdBy, input.actorId),
                inArray(importsTable.state, ["queued", "running"]),
              ),
            )
        : await query.where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              inArray(importsTable.state, ["queued", "running"]),
            ),
          );
      return row?.count ?? 0;
    },

    async claimExecutionSlice(input: {
      claimGeneration: number;
      importId: string;
      jobId: string;
      leaseOwner: string;
      limit: number;
      now: Date;
      staleBefore: Date;
      workspaceId: string;
    }) {
      return database.transaction(async (transaction) => {
        const [job] = await transaction
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.workspaceId, input.workspaceId),
              eq(jobs.kind, "import_execute"),
              eq(jobs.state, "running"),
              eq(jobs.leaseOwner, input.leaseOwner),
              eq(jobs.claimGeneration, input.claimGeneration),
              gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .limit(1)
          .for("update");
        if (!job) return { status: "lease_lost" as const };
        const [locked] = await transaction
          .select()
          .from(importsTable)
          .where(
            and(
              eq(importsTable.id, input.importId),
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.executionJobId, input.jobId),
            ),
          )
          .limit(1)
          .for("update");
        if (!locked) return { status: "binding_not_found" as const };
        if (
          locked.state === "completed" ||
          locked.state === "completed_with_errors"
        ) {
          return { status: "terminal" as const, import: locked };
        }
        if (locked.state !== "queued" && locked.state !== "running") {
          return { status: "invalid_state" as const, import: locked };
        }
        let current = locked;
        if (locked.state === "queued") {
          const [started] = await transaction
            .update(importsTable)
            .set({
              state: "running",
              startedAt: input.now,
              completedAt: null,
              updatedAt: input.now,
              updatedBy: locked.createdBy,
              version: sql`${importsTable.version} + 1`,
            })
            .where(
              and(
                eq(importsTable.id, locked.id),
                eq(importsTable.workspaceId, input.workspaceId),
                eq(importsTable.executionJobId, input.jobId),
                eq(importsTable.state, "queued"),
                eq(importsTable.version, locked.version),
              ),
            )
            .returning();
          if (!started) return { status: "state_conflict" as const };
          await transaction.insert(auditEvents).values({
            id: newId(),
            workspaceId: input.workspaceId,
            action: "import.execution_started",
            resourceKind: "import",
            resourceId: started.id,
            requestId: `worker:${input.leaseOwner}`,
            outcome: "success",
            redactedDiff: { jobId: input.jobId, state: "running" },
            actorUserId: null,
            sessionId: null,
            apiKeyId: null,
            occurredAt: input.now,
          });
          current = started;
        }
        await transaction
          .update(importRows)
          .set({ state: "pending", updatedAt: input.now })
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.importId),
              eq(importRows.state, "processing"),
              lt(importRows.updatedAt, input.staleBefore),
            ),
          );
        const candidates = await transaction
          .select({ id: importRows.id })
          .from(importRows)
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.importId),
              eq(importRows.state, "pending"),
            ),
          )
          .orderBy(asc(importRows.rowNumber))
          .limit(input.limit)
          .for("update", { skipLocked: true });
        const rows = candidates.length
          ? await transaction
              .update(importRows)
              .set({ state: "processing", updatedAt: input.now })
              .where(
                and(
                  eq(importRows.workspaceId, input.workspaceId),
                  eq(importRows.importId, input.importId),
                  inArray(
                    importRows.id,
                    candidates.map((row) => row.id),
                  ),
                ),
              )
              .returning()
          : [];
        return { status: "claimed" as const, import: current, rows };
      });
    },

    async refreshExecutionTotals(input: {
      claimGeneration: number;
      id: string;
      jobId: string;
      leaseOwner: string;
      now: Date;
      workspaceId: string;
    }) {
      return database.transaction(async (transaction) => {
        const [job] = await transaction
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.workspaceId, input.workspaceId),
              eq(jobs.kind, "import_execute"),
              eq(jobs.state, "running"),
              eq(jobs.leaseOwner, input.leaseOwner),
              eq(jobs.claimGeneration, input.claimGeneration),
              gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .limit(1)
          .for("update");
        if (!job) return { status: "lease_lost" as const };
        const [locked] = await transaction
          .select()
          .from(importsTable)
          .where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.id, input.id),
              eq(importsTable.executionJobId, input.jobId),
            ),
          )
          .limit(1)
          .for("update");
        if (!locked) return { status: "binding_not_found" as const };
        if (
          locked.state === "completed" ||
          locked.state === "completed_with_errors"
        ) {
          return { status: "terminal" as const, import: locked };
        }
        if (locked.state !== "running") {
          return { status: "invalid_state" as const, import: locked };
        }
        const totals = await transaction
          .select({
            state: importRows.state,
            count: sql<number>`count(*)::integer`,
          })
          .from(importRows)
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.id),
            ),
          )
          .groupBy(importRows.state);
        const byState = new Map(totals.map((row) => [row.state, row.count]));
        const physicalCount = [...byState.values()].reduce(
          (sum, count) => sum + count,
          0,
        );
        const accepted = byState.get("succeeded") ?? 0;
        const rejected = byState.get("rejected") ?? 0;
        const pending = byState.get("pending") ?? 0;
        const processing = byState.get("processing") ?? 0;
        if (
          physicalCount !== locked.totalRows ||
          accepted + rejected + pending + processing !== locked.totalRows
        ) {
          return { status: "invariant_error" as const, import: locked };
        }
        const complete =
          pending === 0 &&
          processing === 0 &&
          accepted + rejected === locked.totalRows;
        const [updated] = await transaction
          .update(importsTable)
          .set({
            acceptedRows: accepted,
            rejectedRows: rejected,
            state: complete
              ? rejected
                ? "completed_with_errors"
                : "completed"
              : "running",
            completedAt: complete ? input.now : null,
            updatedAt: input.now,
            version: sql`${importsTable.version} + 1`,
          })
          .where(
            and(
              eq(importsTable.workspaceId, input.workspaceId),
              eq(importsTable.id, input.id),
              eq(importsTable.executionJobId, input.jobId),
              eq(importsTable.state, "running"),
              eq(importsTable.version, locked.version),
            ),
          )
          .returning();
        if (updated && complete) {
          await transaction.insert(auditEvents).values({
            id: newId(),
            workspaceId: input.workspaceId,
            action: "import.execution_finished",
            resourceKind: "import",
            resourceId: updated.id,
            requestId: `worker:${input.leaseOwner}`,
            outcome: rejected ? "completed_with_errors" : "success",
            redactedDiff: {
              acceptedRows: accepted,
              jobId: input.jobId,
              rejectedRows: rejected,
              state: updated.state,
            },
            actorUserId: null,
            sessionId: null,
            apiKeyId: null,
            occurredAt: input.now,
          });
        }
        return updated
          ? { status: "updated" as const, import: updated }
          : { status: "state_conflict" as const };
      });
    },

    async claimRows(input: {
      importId: string;
      workspaceId: string;
      limit: number;
      now: Date;
    }): Promise<ImportStagedRow[]> {
      return database.transaction(async (transaction) => {
        const candidates = await transaction
          .select({ id: importRows.id })
          .from(importRows)
          .where(
            and(
              eq(importRows.workspaceId, input.workspaceId),
              eq(importRows.importId, input.importId),
              eq(importRows.state, "pending"),
            ),
          )
          .orderBy(asc(importRows.rowNumber))
          .limit(input.limit)
          .for("update", { skipLocked: true });
        if (!candidates.length) return [];
        return transaction
          .update(importRows)
          .set({ state: "processing", updatedAt: input.now })
          .where(
            inArray(
              importRows.id,
              candidates.map((row) => row.id),
            ),
          )
          .returning();
      });
    },

    async recoverStaleRows(input: {
      importId: string;
      workspaceId: string;
      staleBefore: Date;
      now: Date;
    }): Promise<number> {
      const rows = await database
        .update(importRows)
        .set({ state: "pending", updatedAt: input.now })
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.importId),
            eq(importRows.state, "processing"),
            lt(importRows.updatedAt, input.staleBefore),
          ),
        )
        .returning({ id: importRows.id });
      return rows.length;
    },

    async finishRow(input: {
      id: string;
      importId: string;
      workspaceId: string;
      state: "rejected" | "succeeded";
      resultReferences: readonly string[];
      validationErrors: readonly unknown[];
      now: Date;
    }): Promise<boolean> {
      const [row] = await database
        .update(importRows)
        .set({
          state: input.state,
          resultReferences: [...input.resultReferences],
          validationErrors: [...input.validationErrors],
          updatedAt: input.now,
        })
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.importId),
            eq(importRows.id, input.id),
            eq(importRows.state, "processing"),
          ),
        )
        .returning({ id: importRows.id });
      return Boolean(row);
    },

    async refreshTotals(input: { id: string; workspaceId: string; now: Date }) {
      const totals = await database
        .select({
          state: importRows.state,
          count: sql<number>`count(*)::integer`,
        })
        .from(importRows)
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, input.id),
          ),
        )
        .groupBy(importRows.state);
      const byState = new Map(totals.map((row) => [row.state, row.count]));
      const total = [...byState.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
      const accepted = byState.get("succeeded") ?? 0;
      const rejected = byState.get("rejected") ?? 0;
      const complete = accepted + rejected === total;
      const [row] = await database
        .update(importsTable)
        .set({
          totalRows: total,
          acceptedRows: accepted,
          rejectedRows: rejected,
          state: complete
            ? rejected
              ? "completed_with_errors"
              : "completed"
            : "running",
          completedAt: complete ? input.now : null,
          updatedAt: input.now,
          version: sql`${importsTable.version} + 1`,
        })
        .where(
          and(
            eq(importsTable.workspaceId, input.workspaceId),
            eq(importsTable.id, input.id),
          ),
        )
        .returning();
      return row ?? null;
    },
  };
}

export type ImportsRepository = ReturnType<typeof createImportsRepository>;
