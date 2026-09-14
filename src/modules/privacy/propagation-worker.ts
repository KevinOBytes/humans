import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import { evidenceExcerpts, evidenceItems } from "@/db/schema/evidence";
import { files } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { relationships } from "@/db/schema/relationships";
import { searchDocuments } from "@/db/schema/search";
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

/** A processor can fail closed with a stable, redacted operational reason. */
export class PrivacyProcessorError extends Error {
  constructor(readonly resultCode: string) {
    super(resultCode);
    this.name = "PrivacyProcessorError";
  }
}

/**
 * Purges app-owned search contributions for the people covered by a privacy
 * request. The workspace predicate is deliberately repeated on every branch:
 * a subject id is not a sufficient tenant boundary on its own. Direct person
 * documents are included even when an older index row did not carry the
 * subjectPersonId column, while dependent contributions use that explicit
 * subject link.
 *
 * The operation is intentionally idempotent. A retry sees zero rows and
 * returns the same opaque request-scoped evidence reference. It never scans
 * Redis, calls a hosted search provider, or returns indexed content.
 */
export function createSearchPrivacyProcessorAdapter(): PrivacyProcessorAdapter {
  return async ({ database, request }) => {
    const personIds = request.scope.personIds;
    const fileIds = request.scope.fileIds;
    const evidenceReference = `search-purge:${request.id}`;
    if (request.requestType === "correction")
      throw new PrivacyProcessorError("search_reindex_required");
    if (!personIds.length && !fileIds.length)
      return {
        state: "not_applicable",
        evidenceReference: "search:no-scoped-people",
      };

    const evidenceItemIds = fileIds.length
      ? database
          .select({ id: evidenceItems.id })
          .from(evidenceItems)
          .where(
            and(
              eq(evidenceItems.workspaceId, request.workspaceId),
              inArray(evidenceItems.fileId, fileIds),
            ),
          )
      : null;
    const evidenceExcerptIds = fileIds.length
      ? database
          .select({ id: evidenceExcerpts.id })
          .from(evidenceExcerpts)
          .innerJoin(
            evidenceItems,
            and(
              eq(evidenceItems.workspaceId, evidenceExcerpts.workspaceId),
              eq(evidenceItems.id, evidenceExcerpts.evidenceItemId),
            ),
          )
          .where(
            and(
              eq(evidenceExcerpts.workspaceId, request.workspaceId),
              inArray(evidenceItems.fileId, fileIds),
            ),
          )
      : null;
    const relationshipIds = personIds.length
      ? database
          .select({ id: relationships.id })
          .from(relationships)
          .where(
            and(
              eq(relationships.workspaceId, request.workspaceId),
              or(
                inArray(relationships.sourcePersonId, personIds),
                inArray(relationships.targetPersonId, personIds),
              ),
              isNull(relationships.deletedAt),
            ),
          )
      : null;

    const documentScope = [
      personIds.length
        ? or(
            inArray(searchDocuments.subjectPersonId, personIds),
            and(
              eq(searchDocuments.resourceKind, "person"),
              inArray(searchDocuments.resourceId, personIds),
            ),
          )
        : null,
      relationshipIds
        ? and(
            eq(searchDocuments.resourceKind, "relationship"),
            inArray(searchDocuments.resourceId, relationshipIds),
          )
        : null,
      evidenceItemIds
        ? and(
            eq(searchDocuments.resourceKind, "evidence_item"),
            inArray(searchDocuments.resourceId, evidenceItemIds),
          )
        : null,
      evidenceExcerptIds
        ? and(
            eq(searchDocuments.resourceKind, "evidence_excerpt"),
            inArray(searchDocuments.resourceId, evidenceExcerptIds),
          )
        : null,
    ].filter((scope): scope is NonNullable<typeof scope> => scope !== null);

    await database
      .delete(searchDocuments)
      .where(
        and(
          eq(searchDocuments.workspaceId, request.workspaceId),
          or(...documentScope),
        ),
      );

    return { state: "succeeded", evidenceReference };
  };
}

/**
 * Redis is operational-only in this deployment. It does not contain
 * person-derived records, so privacy propagation records that capability
 * explicitly instead of pretending that a shared key scan or flush is safe.
 */
export function createCachePrivacyProcessorAdapter(): PrivacyProcessorAdapter {
  return async () => ({
    state: "not_applicable",
    evidenceReference: "cache:not-applicable:operational-only",
  });
}

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
      } catch (error) {
        result = null;
        resultCode =
          error instanceof PrivacyProcessorError
            ? error.resultCode
            : "processor_failed";
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
