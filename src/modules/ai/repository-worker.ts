import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  aiCitations,
  aiEphemeralInputs,
  aiMessages,
  aiRuns,
  aiToolCalls,
} from "@/db/schema/ai";
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
  MAX_AI_PROVIDER_BOUNDARIES,
  MAX_AI_TOOL_CALLS,
  equalAiDigest,
  isOmittedAiUserMessage,
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
      if (isOmittedAiUserMessage(plaintext)) {
        const [ephemeral] = await transaction
          .select()
          .from(aiEphemeralInputs)
          .where(
            and(
              eq(aiEphemeralInputs.workspaceId, run.workspaceId),
              eq(aiEphemeralInputs.threadId, run.threadId),
              eq(aiEphemeralInputs.aiRunId, run.id),
              gt(aiEphemeralInputs.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .limit(1)
          .for("update");
        if (!ephemeral) return null;
        const ephemeralPlaintext = openSealedEnvelope({
          key: runtime.encryptionKey,
          purpose: "ai-ephemeral-input",
          token: ephemeral.encryptedContent,
        });
        if (
          !equalAiDigest(
            ephemeral.contentHash,
            prefixedAiPersistenceHmac(
              runtime,
              "ephemeral-input",
              ephemeralPlaintext,
            ),
          ) ||
          !equalAiDigest(
            run.promptHash,
            prefixedAiPersistenceHmac(runtime, "prompt", ephemeralPlaintext),
          )
        ) {
          return null;
        }
        await transaction
          .update(aiEphemeralInputs)
          .set({
            claimedAt: sql`coalesce(${aiEphemeralInputs.claimedAt}, clock_timestamp())`,
          })
          .where(eq(aiEphemeralInputs.id, ephemeral.id));
        return parseStoredAiUserMessage(ephemeralPlaintext);
      }
      if (
        !equalAiDigest(
          run.promptHash,
          prefixedAiPersistenceHmac(runtime, "prompt", plaintext),
        )
      ) {
        return null;
      }
      return parseStoredAiUserMessage(plaintext);
    } catch {
      return null;
    }
  }

  function scopeReferences(scope: ClaimedAiRun["scope"]) {
    return [
      ...scope.personIds.map((id) => ({ id, kind: "person" as const })),
      ...scope.evidenceIds.map((id) => ({ id, kind: "evidence" as const })),
    ];
  }

  function claimedRunValue(
    run: StoredRun,
    parsed: ReturnType<typeof parseStoredAiUserMessage>,
  ): ClaimedAiRun {
    return Object.freeze({
      configurationHash: run.configurationHash,
      model: run.model,
      principalId: run.createdBy,
      promptHash: run.promptHash,
      provider: run.provider as ClaimedAiRun["provider"],
      question: parsed.question,
      scope: parsed.scope,
      threadId: run.threadId,
    });
  }

  function providerBoundaryCount(profile: unknown): number | null {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return null;
    }
    const value = (profile as Record<string, unknown>).providerBoundaryCount;
    if (value === undefined) return 0;
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : null;
  }

  async function claimedToolCallCount(
    transaction: Database,
    input: AiJobClaim,
  ): Promise<number> {
    const [{ count }] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(aiToolCalls)
      .where(
        and(
          eq(aiToolCalls.workspaceId, input.workspaceId),
          eq(aiToolCalls.aiRunId, input.runId),
          eq(aiToolCalls.state, "completed"),
        ),
      );
    return count;
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
          return claimedRunValue(run, parsed);
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return null;
        throw error;
      }
    },

    async authorizeClaimedRun(input: AiJobClaim) {
      try {
        return await database.transaction(async (transactionValue) => {
          const transaction = transactionValue as unknown as Database;
          const run = await lockClaimedRun(transaction, input);
          if (!run) return null;
          const parsed = await loadValidatedRunInput(transaction, run);
          if (!parsed || !validAiProvider(run.provider)) return null;
          const authorization = await authorizeAiReferences(transaction, {
            principalId: run.createdBy,
            references: scopeReferences(parsed.scope),
            requiredPermissions: ["analysis:read", "analysis:run"],
            scope: parsed.scope,
            workspaceId: input.workspaceId,
          });
          if (!authorization) return null;
          const providerBoundaries = providerBoundaryCount(
            run.capabilityProfile,
          );
          if (providerBoundaries == null) return null;
          const toolCallCount = await claimedToolCallCount(transaction, input);
          if (!(await lockCurrentClaim(transaction, input))) {
            throw new AiClaimLostRollback();
          }
          return Object.freeze({
            run: claimedRunValue(run, parsed),
            authority: authorization.authority,
            providerBoundaryCount: providerBoundaries,
            toolCallCount,
          });
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return null;
        throw error;
      }
    },

    async recordClaimedProviderBoundary(input: AiJobClaim) {
      try {
        return await database.transaction(async (transactionValue) => {
          const transaction = transactionValue as unknown as Database;
          const run = await lockClaimedRun(transaction, input);
          if (!run) return null;
          const parsed = await loadValidatedRunInput(transaction, run);
          if (!parsed || !validAiProvider(run.provider)) return null;
          const authorization = await authorizeAiReferences(transaction, {
            principalId: run.createdBy,
            references: scopeReferences(parsed.scope),
            requiredPermissions: ["analysis:read", "analysis:run"],
            scope: parsed.scope,
            workspaceId: input.workspaceId,
          });
          if (!authorization) return null;
          const consumed = providerBoundaryCount(run.capabilityProfile);
          if (consumed == null) return null;
          if (consumed >= MAX_AI_PROVIDER_BOUNDARIES) {
            return Object.freeze({ outcome: "limit" as const });
          }
          const profile = run.capabilityProfile as Record<string, unknown>;
          await transaction
            .update(aiRuns)
            .set({
              capabilityProfile: {
                ...profile,
                providerBoundaryCount: consumed + 1,
              },
            })
            .where(
              and(
                eq(aiRuns.id, input.runId),
                eq(aiRuns.workspaceId, input.workspaceId),
                inArray(aiRuns.state, ["pending", "running"]),
              ),
            );
          if (!(await lockCurrentClaim(transaction, input))) {
            throw new AiClaimLostRollback();
          }
          return Object.freeze({
            outcome: "recorded" as const,
          });
        });
      } catch (error) {
        if (error instanceof AiClaimLostRollback) return null;
        throw error;
      }
    },

    async isClaimedRunCompleted(input: AiJobClaim): Promise<boolean> {
      return database.transaction(async (transactionValue) => {
        const transaction = transactionValue as unknown as Database;
        const job = await lockCurrentClaim(transaction, input);
        if (!job?.principalId) return false;
        const [run] = await transaction
          .select({ id: aiRuns.id })
          .from(aiRuns)
          .where(
            and(
              eq(aiRuns.id, input.runId),
              eq(aiRuns.workspaceId, input.workspaceId),
              eq(aiRuns.createdBy, job.principalId),
              eq(aiRuns.state, "completed"),
            ),
          )
          .limit(1)
          .for("update");
        return Boolean(run && (await lockCurrentClaim(transaction, input)));
      });
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
          if (!protectedInput) return false;
          const authorization = await authorizeAiReferences(transaction, {
            principalId: run.createdBy,
            references: scopeReferences(protectedInput.scope),
            requiredPermissions: ["analysis:read", "analysis:run"],
            scope: protectedInput.scope,
            workspaceId: input.workspaceId,
          });
          if (!authorization) return false;
          const authorizedScope = new Set(
            authorization.references.map(
              (reference) => `${reference.kind}:${reference.id}`,
            ),
          );
          const requestedReferences = new Set(
            resourceReferences.map(
              (reference) => `${reference.kind}:${reference.id}`,
            ),
          );
          if (
            [...requestedReferences].some(
              (reference) => !authorizedScope.has(reference),
            )
          ) {
            return false;
          }
          const authorizedReferences = authorization.references.filter(
            (reference) =>
              requestedReferences.has(`${reference.kind}:${reference.id}`),
          );
          const count = await claimedToolCallCount(transaction, input);
          if (count >= MAX_AI_TOOL_CALLS) return false;
          const now = new Date();
          await transaction.insert(aiToolCalls).values({
            id: newId(),
            workspaceId: input.workspaceId,
            aiRunId: input.runId,
            approvedToolName: input.approvedToolName,
            redactedArguments,
            redactedResultSummary,
            resourceReferences: authorizedReferences,
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
          const authorization = await authorizeAiReferences(transaction, {
            principalId: run.createdBy,
            references: scopeReferences(protectedInput.scope),
            requiredPermissions: ["analysis:read", "analysis:run"],
            scope: protectedInput.scope,
            workspaceId: input.workspaceId,
          });
          if (!authorization) return false;
          const authorizedScope = new Set(
            authorization.references.map(
              (reference) => `${reference.kind}:${reference.id}`,
            ),
          );
          if (
            citationReferences.some(
              (reference) =>
                !authorizedScope.has(`${reference.kind}:${reference.id}`),
            )
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
          await transaction
            .delete(aiEphemeralInputs)
            .where(
              and(
                eq(aiEphemeralInputs.workspaceId, input.workspaceId),
                eq(aiEphemeralInputs.threadId, run.threadId),
                eq(aiEphemeralInputs.aiRunId, input.runId),
              ),
            );
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
          await transaction
            .delete(aiEphemeralInputs)
            .where(
              and(
                eq(aiEphemeralInputs.workspaceId, input.workspaceId),
                eq(aiEphemeralInputs.threadId, run.threadId),
                eq(aiEphemeralInputs.aiRunId, input.runId),
              ),
            );
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
