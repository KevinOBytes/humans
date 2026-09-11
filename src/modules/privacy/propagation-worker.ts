import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import {
  deletionRequests,
  privacyRequests,
  privacyProcessorPropagations,
} from "@/db/schema/privacy";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { privacyRequestHeld } from "./request-service";
import type { PrivacyProcessor, PrivacyRequestRow } from "./request-types";

export type PropagationResult = {
  state: "succeeded" | "not_applicable";
  evidenceReference: string;
};
export type PrivacyProcessorAdapter = (input: {
  database: Database;
  request: PrivacyRequestRow;
  idempotencyKey: string;
}) => Promise<PropagationResult>;

/** Processor adapters must honor the stable key and return an opaque evidence
 * reference, never personal content. Missing adapters fail visibly and retry;
 * queuing deletion is never evidence of external erasure. */
export async function executePrivacyPropagations(input: {
  database: Database;
  limit?: number;
  now?: Date;
  adapters?: Partial<Record<PrivacyProcessor, PrivacyProcessorAdapter>>;
}) {
  const limit = input.limit ?? 25;
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Invalid propagation batch size");
  const candidates = await input.database
    .select()
    .from(privacyProcessorPropagations)
    .where(
      and(
        inArray(privacyProcessorPropagations.state, ["pending", "failed"]),
        lte(privacyProcessorPropagations.nextAttemptAt, now),
      ),
    )
    .orderBy(
      asc(privacyProcessorPropagations.nextAttemptAt),
      asc(privacyProcessorPropagations.id),
    )
    .limit(limit);
  let processed = 0;
  for (const candidate of candidates)
    await input.database.transaction(async (tx) => {
      const database = tx as unknown as Database;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${candidate.workspaceId}, 0))`,
      );
      const [request] = await tx
        .select()
        .from(privacyRequests)
        .where(
          and(
            eq(privacyRequests.workspaceId, candidate.workspaceId),
            eq(privacyRequests.id, candidate.privacyRequestId),
            eq(privacyRequests.state, "fulfilling"),
            isNull(privacyRequests.deletedAt),
            lte(privacyRequests.executeAfter, now),
          ),
        )
        .for("update");
      if (!request?.verifiedAt || !request.reviewedBy) return;
      if (
        request.requestType === "deletion" &&
        (await privacyRequestHeld(
          { database, workspaceId: candidate.workspaceId },
          request,
        ))
      )
        return;
      const [row] = await tx
        .select()
        .from(privacyProcessorPropagations)
        .where(
          and(
            eq(privacyProcessorPropagations.workspaceId, candidate.workspaceId),
            eq(privacyProcessorPropagations.id, candidate.id),
            inArray(privacyProcessorPropagations.state, ["pending", "failed"]),
            lte(privacyProcessorPropagations.nextAttemptAt, now),
          ),
        )
        .for("update", { skipLocked: true });
      if (!row) return;
      if (request.legacyDeletionRequestId) {
        const [legacy] = await tx
          .select({ state: deletionRequests.state })
          .from(deletionRequests)
          .where(
            and(
              eq(deletionRequests.workspaceId, request.workspaceId),
              eq(deletionRequests.id, request.legacyDeletionRequestId),
            ),
          )
          .limit(1);
        if (legacy?.state !== "completed") return;
      }
      let result: PropagationResult | null = null;
      let resultCode = "processor_unconfigured";
      const adapter = input.adapters?.[row.processor as PrivacyProcessor];
      try {
        if (adapter) {
          result = await adapter({ database, request, idempotencyKey: row.id });
          if (
            !["succeeded", "not_applicable"].includes(result.state) ||
            !/^[a-zA-Z0-9:._/-]{1,200}$/u.test(result.evidenceReference)
          )
            throw new Error("Invalid processor evidence");
        } else if (
          row.processor === "files" &&
          request.requestType === "deletion"
        ) {
          const resources = request.scope.fileIds.length
            ? await tx
                .select({ completedAt: files.cleanupCompletedAt })
                .from(files)
                .where(
                  and(
                    eq(files.workspaceId, request.workspaceId),
                    inArray(files.id, request.scope.fileIds),
                  ),
                )
            : [];
          if (!request.scope.fileIds.length)
            result = {
              state: "not_applicable",
              evidenceReference: "no-scoped-files",
            };
          else if (
            resources.length === request.scope.fileIds.length &&
            resources.every((f) => f.completedAt)
          )
            result = {
              state: "succeeded",
              evidenceReference: `file-cleanup:${request.id}`,
            };
          else resultCode = "file_cleanup_pending";
        }
      } catch {
        result = null;
        resultCode = "processor_failed";
      }
      const auditReference = newId();
      await tx.insert(auditEvents).values({
        id: auditReference,
        workspaceId: row.workspaceId,
        actorUserId: null,
        sessionId: null,
        apiKeyId: null,
        action: "privacy.processor.result",
        resourceKind: "privacy_request",
        resourceId: request.id,
        requestId: `privacy-worker:${row.id}`,
        redactedDiff: {
          processor: row.processor,
          state: result?.state ?? "failed",
          resultCode: result ? "evidence_recorded" : resultCode,
        },
        outcome: result ? "success" : "failure",
      });
      await tx
        .update(privacyProcessorPropagations)
        .set({
          state: result?.state ?? "failed",
          attempts: row.attempts + 1,
          resultCode: result ? "evidence_recorded" : resultCode,
          evidenceReference: result?.evidenceReference ?? null,
          auditReference,
          nextAttemptAt: new Date(
            now.getTime() +
              Math.min(86_400_000, 60_000 * 2 ** Math.min(row.attempts, 10)),
          ),
          updatedAt: now,
          updatedBy: "worker:privacy",
          version: row.version + 1,
        })
        .where(
          and(
            eq(privacyProcessorPropagations.workspaceId, row.workspaceId),
            eq(privacyProcessorPropagations.id, row.id),
          ),
        );
      processed += 1;
    });
  return processed;
}
