import { and, eq, isNull, not, sql } from "drizzle-orm";

import { aiRuns, aiThreads } from "@/db/schema/ai";
import { auditEvents } from "@/db/schema/operations";
import { legalHolds, workspaceSettings } from "@/db/schema/workspaces";
import { newId } from "@/db/id";
import type { Database } from "@/modules/auth/bootstrap-admin";

const MAX_RETENTION_BATCH = 500;

/**
 * Permanently removes expired private AI threads after honoring workspace and
 * thread retention settings. Pending/running work and active legal holds are
 * never removed. The worker records only a redacted count/id audit event.
 */
export async function purgeExpiredAiThreads(input: {
  database: Database;
  limit?: number;
  now?: Date;
}): Promise<number> {
  const limit = input.limit ?? MAX_RETENTION_BATCH;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RETENTION_BATCH
  ) {
    throw new TypeError("Invalid AI retention batch size");
  }
  const now = input.now ?? new Date();
  let purged = 0;
  await input.database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        id: aiThreads.id,
        workspaceId: aiThreads.workspaceId,
      })
      .from(aiThreads)
      .innerJoin(
        workspaceSettings,
        eq(workspaceSettings.workspaceId, aiThreads.workspaceId),
      )
      .where(
        and(
          isNull(aiThreads.deletedAt),
          eq(aiThreads.sharing, "private"),
          sql`coalesce(${aiThreads.retentionDays}, ${workspaceSettings.retentionDays}) is not null`,
          sql`${aiThreads.updatedAt} < ${now.toISOString()}::timestamptz - (coalesce(${aiThreads.retentionDays}, ${workspaceSettings.retentionDays}) * interval '1 day')`,
          sql`exists (select 1 from ${aiRuns} where ${aiRuns.workspaceId} = ${aiThreads.workspaceId} and ${aiRuns.threadId} = ${aiThreads.id} and ${aiRuns.state} = 'completed')`,
          not(
            sql`exists (select 1 from ${aiRuns} where ${aiRuns.workspaceId} = ${aiThreads.workspaceId} and ${aiRuns.threadId} = ${aiThreads.id} and ${aiRuns.state} in ('pending', 'running'))`,
          ),
          not(
            sql`exists (select 1 from ${legalHolds} where ${legalHolds.workspaceId} = ${aiThreads.workspaceId} and ${legalHolds.resourceId} = ${aiThreads.id} and ${legalHolds.resourceKind} = 'ai_thread' and ${legalHolds.state} = 'active' and ${legalHolds.deletedAt} is null)`,
          ),
        ),
      )
      .orderBy(aiThreads.updatedAt, aiThreads.id)
      .limit(limit)
      .for("update");

    for (const candidate of candidates) {
      const [deleted] = await transaction
        .delete(aiThreads)
        .where(
          and(
            eq(aiThreads.workspaceId, candidate.workspaceId),
            eq(aiThreads.id, candidate.id),
            isNull(aiThreads.deletedAt),
          ),
        )
        .returning({ id: aiThreads.id });
      if (!deleted) continue;
      await transaction.insert(auditEvents).values({
        id: newId(),
        workspaceId: candidate.workspaceId,
        actorUserId: null,
        sessionId: null,
        apiKeyId: null,
        action: "ai.retention.purged",
        resourceKind: "ai_thread",
        resourceId: candidate.id,
        requestId: "worker:ai-retention",
        redactedDiff: { reason: "retention_expired" },
        outcome: "success",
        occurredAt: now,
      });
      purged += 1;
    }
  });
  return purged;
}
