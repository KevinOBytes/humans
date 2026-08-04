import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { aiCitations, aiMessages, aiRuns, aiToolCalls } from "@/db/schema/ai";
import { auditEvents, jobs } from "@/db/schema/operations";
import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { decodeJobPayload } from "@/modules/jobs/service";
import { authorizeAiReferences } from "./repository-authority";
import {
  AI_TOOL_NAME,
  MAX_AI_ANSWER_BYTES,
  MAX_AI_TOOL_CALLS,
  equalAiDigest,
  isAiStableErrorCode,
  parseStoredAiUserMessage,
  prefixedAiPersistenceHmac,
  validAiProvider,
  validateAiCitations,
  validateAiJobClaim,
  validateAiResourceReferences,
  validateRedactedToolJson,
  type AiCitation,
  type AiJobClaim,
  type AiRepositoryRuntime,
  type ClaimedAiRun,
} from "./repository-domain";

type StoredRun = typeof aiRuns.$inferSelect;

class AiClaimLostRollback extends Error {}

export function createAiWorkerRepository(
  database: Database,
  runtime: AiRepositoryRuntime,
) {
  async function lockCurrentClaim(
    transaction: Database,
    input: AiJobClaim,
  ): Promise<typeof jobs.$inferSelect | null> {
    validateAiJobClaim(input);
    const [job] = await transaction
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.id, input.jobId),
          eq(jobs.workspaceId, input.workspaceId),
          eq(jobs.kind, "ai_execute"),
          eq(jobs.state, "running"),
          eq(jobs.claimGeneration, input.claimGeneration),
          eq(jobs.leaseOwner, input.leaseOwner),
          gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(1)
      .for("update");
    if (!job) return null;
    try {
      const payload = decodeJobPayload({
        encryptedPayload: job.encryptedPayload,
        key: runtime.encryptionKey,
        kind: "ai_execute",
        payloadHash: job.payloadHash,
      });
      return payload.kind === "ai_execute" && payload.runId === input.runId
        ? job
        : null;
    } catch {
      return null;
    }
  }

  async function lockClaimedRun(
    transaction: Database,
    input: AiJobClaim,
  ): Promise<StoredRun | null> {
    const job = await lockCurrentClaim(transaction, input);
    if (!job?.principalId) return null;
    const [run] = await transaction
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.id, input.runId),
          eq(aiRuns.workspaceId, input.workspaceId),
          eq(aiRuns.createdBy, job.principalId),
          inArray(aiRuns.state, ["pending", "running"]),
        ),
      )
      .limit(1)
      .for("update");
    return run ?? null;
  }

  async function loadValidatedRunInput(
    transaction: Database,
    run: StoredRun,
  ): Promise<ReturnType<typeof parseStoredAiUserMessage> | null> {
    if (!run.messageId || !validAiProvider(run.provider)) return null;
    const [message] = await transaction
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.workspaceId, run.workspaceId),
          eq(aiMessages.threadId, run.threadId),
          eq(aiMessages.id, run.messageId),
          eq(aiMessages.role, "user"),
        ),
      )
      .limit(1);
    if (!message) return null;
    try {
      const plaintext = openSealedEnvelope({
        key: runtime.encryptionKey,
        purpose: "ai-user-message",
        token: message.encryptedContent,
      });
      if (
        !equalAiDigest(
          message.contentHash,
          prefixedAiPersistenceHmac(runtime, "user-content", plaintext),
        )
      ) {
        return null;
      }
      return parseStoredAiUserMessage(plaintext);
    } catch {
      return null;
    }
  }

  return {
    async loadClaimedPendingRun(
      input: AiJobClaim,
    ): Promise<ClaimedAiRun | null> {
      try {
        return await database.transaction(async (transactionValue) => {
          const transaction = transactionValue as unknown as Database;
          const run = await lockClaimedRun(transaction, input);
          if (!run) return null;
          const parsed = await loadValidatedRunInput(transaction, run);
          if (!parsed || !validAiProvider(run.provider)) return null;
          if (run.state === "pending") {
            const [started] = await transaction
              .update(aiRuns)
              .set({
                state: "running",
                startedAt: sql<Date>`clock_timestamp()`,
              })
              .where(
                and(
                  eq(aiRuns.workspaceId, input.workspaceId),
                  eq(aiRuns.id, input.runId),
                  eq(aiRuns.state, "pending"),
                ),
              )
              .returning({ id: aiRuns.id });
            if (!started) return null;
          }
          if (!(await lockCurrentClaim(transaction, input))) {
            throw new AiClaimLostRollback();
          }
          return Object.freeze({
            configurationHash: run.configurationHash,
            model: run.model,
            principalId: run.createdBy,
            promptHash: run.promptHash,
            provider: run.provider,
            question: parsed.question,
            scope: parsed.scope,
            threadId: run.threadId,
          });
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return null;
        throw error;
      }
    },

    async recordClaimedToolCall(
      input: AiJobClaim & {
        approvedToolName: string;
        redactedArguments: Readonly<Record<string, unknown>>;
        redactedResultSummary: Readonly<Record<string, unknown>> | null;
        resourceReferences: readonly Readonly<{
          id: string;
          kind: "evidence" | "person";
        }>[];
      },
    ): Promise<boolean> {
      if (!AI_TOOL_NAME.test(input.approvedToolName)) {
        throw new TypeError("Invalid redacted tool name");
      }
      const redactedArguments = validateRedactedToolJson(
        input.redactedArguments,
      );
      const redactedResultSummary =
        input.redactedResultSummary == null
          ? null
          : validateRedactedToolJson(input.redactedResultSummary);
      const resourceReferences = validateAiResourceReferences(
        input.resourceReferences,
      );
      try {
        return await database.transaction(async (transactionValue) => {
          const transaction = transactionValue as unknown as Database;
          const run = await lockClaimedRun(transaction, input);
          if (!run) return false;
          const protectedInput = await loadValidatedRunInput(transaction, run);
          if (
            !protectedInput ||
            !(await authorizeAiReferences(transaction, {
              principalId: run.createdBy,
              references: resourceReferences,
              scope: protectedInput.scope,
              workspaceId: input.workspaceId,
            }))
          ) {
            return false;
          }
          const [{ count }] = await transaction
            .select({ count: sql<number>`count(*)::int` })
            .from(aiToolCalls)
            .where(
              and(
                eq(aiToolCalls.workspaceId, input.workspaceId),
                eq(aiToolCalls.aiRunId, input.runId),
              ),
            );
          if (count >= MAX_AI_TOOL_CALLS) return false;
          const now = new Date();
          await transaction.insert(aiToolCalls).values({
            id: newId(),
            workspaceId: input.workspaceId,
            aiRunId: input.runId,
            approvedToolName: input.approvedToolName,
            redactedArguments,
            redactedResultSummary,
            resourceReferences,
            state: "completed",
            startedAt: now,
            completedAt: now,
            createdAt: now,
          });
          if (!(await lockCurrentClaim(transaction, input))) {
            throw new AiClaimLostRollback();
          }
          return true;
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return false;
        throw error;
      }
    },

    async finalizeClaimedRun(
      input: AiJobClaim & { answer: string; citations: readonly AiCitation[] },
    ): Promise<boolean> {
      const answer = input.answer?.normalize?.("NFKC").trim?.();
      if (
        typeof answer !== "string" ||
        Buffer.byteLength(answer, "utf8") < 1 ||
        Buffer.byteLength(answer, "utf8") > MAX_AI_ANSWER_BYTES
      ) {
        throw new TypeError("Invalid AI answer");
      }
      const citations = validateAiCitations(input.citations);
      try {
        return await database.transaction(async (transactionValue) => {
          const transaction = transactionValue as unknown as Database;
          const run = await lockClaimedRun(transaction, input);
          if (!run) return false;
          const protectedInput = await loadValidatedRunInput(transaction, run);
          if (!protectedInput) return false;
          const citationReferences = [
            ...new Map(
              citations.map((citation) => [
                `${citation.resourceKind}:${citation.resourceId}`,
                { id: citation.resourceId, kind: citation.resourceKind },
              ]),
            ).values(),
          ];
          if (
            !(await authorizeAiReferences(transaction, {
              principalId: run.createdBy,
              references: citationReferences,
              scope: protectedInput.scope,
              workspaceId: input.workspaceId,
            }))
          ) {
            return false;
          }
          if (citationReferences.length) {
            const toolRows = await transaction
              .select({ references: aiToolCalls.resourceReferences })
              .from(aiToolCalls)
              .where(
                and(
                  eq(aiToolCalls.workspaceId, input.workspaceId),
                  eq(aiToolCalls.aiRunId, input.runId),
                  eq(aiToolCalls.state, "completed"),
                ),
              );
            let returned: ReadonlySet<string>;
            try {
              returned = new Set(
                toolRows.flatMap((tool) =>
                  validateAiResourceReferences(tool.references).map(
                    (reference) => `${reference.kind}:${reference.id}`,
                  ),
                ),
              );
            } catch {
              return false;
            }
            if (
              citationReferences.some(
                (reference) =>
                  !returned.has(`${reference.kind}:${reference.id}`),
              )
            ) {
              return false;
            }
          }
          const messageId = newId();
          const now = new Date();
          await transaction.insert(aiMessages).values({
            id: messageId,
            workspaceId: input.workspaceId,
            threadId: run.threadId,
            role: "assistant",
            encryptedContent: sealEnvelope({
              key: runtime.encryptionKey,
              purpose: "ai-assistant-message",
              plaintext: answer,
            }),
            contentHash: prefixedAiPersistenceHmac(
              runtime,
              "assistant-content",
              answer,
            ),
            citationCount: citations.length,
            createdAt: now,
            createdBy: run.createdBy,
            updatedAt: now,
            updatedBy: run.createdBy,
          });
          if (citations.length) {
            await transaction.insert(aiCitations).values(
              citations.map((citation) => ({
                id: newId(),
                workspaceId: input.workspaceId,
                threadId: run.threadId,
                aiRunId: input.runId,
                messageId,
                resourceKind: citation.resourceKind,
                resourceId: citation.resourceId,
                evidenceItemId:
                  citation.resourceKind === "evidence"
                    ? citation.resourceId
                    : null,
                locator: citation.locator,
                claimText: citation.claimText,
                createdAt: now,
              })),
            );
          }
          const [completed] = await transaction
            .update(aiRuns)
            .set({ state: "completed", completedAt: now, errorCode: null })
            .where(
              and(
                eq(aiRuns.workspaceId, input.workspaceId),
                eq(aiRuns.id, input.runId),
                inArray(aiRuns.state, ["pending", "running"]),
              ),
            )
            .returning({ id: aiRuns.id });
          if (!completed) return false;
          await transaction.insert(auditEvents).values({
            id: newId(),
            workspaceId: input.workspaceId,
            actorUserId: null,
            sessionId: null,
            apiKeyId: null,
            action: "ai.analysis.completed",
            resourceKind: "ai_run",
            resourceId: input.runId,
            requestId: `worker:${input.leaseOwner}`,
            redactedDiff: { citationCount: citations.length },
            outcome: "success",
            occurredAt: now,
          });
          if (!(await lockCurrentClaim(transaction, input))) {
            throw new AiClaimLostRollback();
          }
          return true;
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return false;
        throw error;
      }
    },

    async recordClaimedFailure(
      input: AiJobClaim & { errorCode: string },
    ): Promise<boolean> {
      if (!isAiStableErrorCode(input.errorCode)) return false;
      try {
        return await database.transaction(async (transactionValue) => {
          const transaction = transactionValue as unknown as Database;
          const run = await lockClaimedRun(transaction, input);
          if (!run) return false;
          const now = new Date();
          const [failed] = await transaction
            .update(aiRuns)
            .set({
              state: "failed",
              completedAt: now,
              errorCode: input.errorCode,
            })
            .where(
              and(
                eq(aiRuns.workspaceId, input.workspaceId),
                eq(aiRuns.id, input.runId),
                inArray(aiRuns.state, ["pending", "running"]),
              ),
            )
            .returning({ id: aiRuns.id });
          if (!failed) return false;
          await transaction.insert(auditEvents).values({
            id: newId(),
            workspaceId: input.workspaceId,
            actorUserId: null,
            sessionId: null,
            apiKeyId: null,
            action: "ai.analysis.failed",
            resourceKind: "ai_run",
            resourceId: input.runId,
            requestId: `worker:${input.leaseOwner}`,
            redactedDiff: { errorCode: input.errorCode },
            outcome: "failure",
            occurredAt: now,
          });
          if (!(await lockCurrentClaim(transaction, input))) {
            throw new AiClaimLostRollback();
          }
          return true;
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return false;
        throw error;
      }
    },
  };
}
