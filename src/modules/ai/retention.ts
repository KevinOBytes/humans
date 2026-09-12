import { and, eq, isNull, not, sql } from "drizzle-orm";

import { aiEphemeralInputs, aiRuns, aiThreads } from "@/db/schema/ai";
import { auditEvents } from "@/db/schema/operations";
import { legalHolds, workspaceSettings } from "@/db/schema/workspaces";
import { newId } from "@/db/id";
import type { Database } from "@/modules/auth/bootstrap-admin";

const MAX_RETENTION_BATCH = 500;

export type AiRetentionCandidateInput = {
  now: Date;
  retentionDays: number;
  runs: readonly {
    id: string;
    createdAt: Date;
    hasAcceptedSuggestion: boolean;
  }[];
  suggestions: readonly {
    id: string;
    runId: string;
    status: string;
  }[];
  citations: readonly { id: string; runId: string }[];
  ephemeralInputs: readonly {
    id: string;
    runId: string;
    expiresAt: Date;
  }[];
  legalHoldResourceIds: ReadonlySet<string>;
};

export type AiRetentionCandidates = {
  runs: string[];
  suggestions: string[];
  citations: string[];
  ephemeralInputs: string[];
};

/**
 * Pure planner used by the worker and tests. It is intentionally separate
 * from deletion: accepted domain resources and anything under a legal hold
 * remain available for provenance and audit review.
 */
export function evaluateAiRetention(
  input: AiRetentionCandidateInput,
): AiRetentionCandidates {
  if (
    !Number.isSafeInteger(input.retentionDays) ||
    input.retentionDays < 0 ||
    Number.isNaN(input.now.getTime())
  )
    throw new TypeError("Invalid AI retention inputs");
  const cutoff = input.now.getTime() - input.retentionDays * 86_400_000;
  const expiredRuns = new Set(
    input.runs
      .filter(
        (run) =>
          run.createdAt.getTime() <= cutoff &&
          !run.hasAcceptedSuggestion &&
          !input.legalHoldResourceIds.has(run.id),
      )
      .map((run) => run.id),
  );
  return {
    runs: [...expiredRuns].sort(),
    suggestions: input.suggestions
      .filter(
        (suggestion) =>
          expiredRuns.has(suggestion.runId) &&
          suggestion.status !== "accepted" &&
          !input.legalHoldResourceIds.has(suggestion.id),
      )
      .map((suggestion) => suggestion.id)
      .sort(),
    citations: input.citations
      .filter(
        (citation) =>
          expiredRuns.has(citation.runId) &&
          !input.legalHoldResourceIds.has(citation.id),
      )
      .map((citation) => citation.id)
      .sort(),
    ephemeralInputs: input.ephemeralInputs
      .filter(
        (ephemeral) =>
          ephemeral.expiresAt.getTime() <= input.now.getTime() &&
          !input.legalHoldResourceIds.has(ephemeral.id) &&
          !input.legalHoldResourceIds.has(ephemeral.runId),
      )
      .map((ephemeral) => ephemeral.id)
      .sort(),
  };
}

export async function purgeExpiredAiEphemeralInputs(input: {
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
    throw new TypeError("Invalid AI ephemeral-input batch size");
  }
  const now = input.now ?? new Date();
  const expired = await input.database.execute(
    sql`delete from ${aiEphemeralInputs}
        where ${aiEphemeralInputs.id} in (
          select ${aiEphemeralInputs.id}
          from ${aiEphemeralInputs}
          where ${aiEphemeralInputs.expiresAt} <= ${now.toISOString()}::timestamptz
            and not exists (
              select 1 from ${legalHolds}
              where ${legalHolds.workspaceId} = ${aiEphemeralInputs.workspaceId}
                and ${legalHolds.resourceId} in (${aiEphemeralInputs.id}, ${aiEphemeralInputs.aiRunId})
                and ${legalHolds.resourceKind} in ('ai_ephemeral_input', 'ai_run')
                and ${legalHolds.state} = 'active'
                and ${legalHolds.deletedAt} is null
            )
          order by ${aiEphemeralInputs.expiresAt}, ${aiEphemeralInputs.id}
          limit ${limit}
        )
        returning ${aiEphemeralInputs.id}`,
  );
  return expired.length;
}

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
