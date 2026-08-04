import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  aiCitations,
  aiMessages,
  aiRuns,
  aiThreads,
  aiToolCalls,
} from "@/db/schema/ai";
import { auditEvents, jobs } from "@/db/schema/operations";
import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import type { ResearchServiceContext } from "@/modules/audit/service";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { createJobsService } from "@/modules/jobs/service";
import {
  AI_STABLE_ERROR_CODE,
  aiPersistenceHmac,
  canonicalAiUserMessage,
  equalAiDigest,
  prefixedAiPersistenceHmac,
  validAiProvider,
  validAiRunState,
  validateAiCitations,
  validateAiRepositoryRuntime,
  validateAiResourceReferences,
  validateRedactedToolJson,
  type AiRepositoryRuntime,
  type AiRun,
  type AiToolSummary,
  type StartAiRowsInput,
} from "./repository-domain";
import { createAiWorkerRepository } from "./repository-worker";

export function aiJobIdempotencyKey(
  runtime: AiRepositoryRuntime,
  input: { principalId: string; runId: string; workspaceId: string },
): string {
  validateAiRepositoryRuntime(runtime);
  return aiPersistenceHmac(
    runtime,
    "job-idempotency",
    `${input.workspaceId}\0${input.principalId}\0${input.runId}`,
  );
}

export function createAiRepository(
  database: Database,
  runtime: AiRepositoryRuntime,
) {
  validateAiRepositoryRuntime(runtime);
  const worker = createAiWorkerRepository(database, runtime);

  async function readOwnedRun(input: {
    principalId: string;
    runId: string;
    workspaceId: string;
  }): Promise<AiRun | null> {
    const [run] = await database
      .select({ run: aiRuns })
      .from(aiRuns)
      .innerJoin(
        aiThreads,
        and(
          eq(aiThreads.workspaceId, aiRuns.workspaceId),
          eq(aiThreads.id, aiRuns.threadId),
          eq(aiThreads.ownerId, input.principalId),
          eq(aiThreads.sharing, "private"),
          isNull(aiThreads.deletedAt),
        ),
      )
      .where(
        and(
          eq(aiRuns.workspaceId, input.workspaceId),
          eq(aiRuns.id, input.runId),
        ),
      )
      .limit(1);
    if (
      !run ||
      !validAiProvider(run.run.provider) ||
      !validAiRunState(run.run.state)
    ) {
      return null;
    }
    const [assistant] = await database
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.workspaceId, input.workspaceId),
          eq(aiMessages.threadId, run.run.threadId),
          eq(aiMessages.role, "assistant"),
        ),
      )
      .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id))
      .limit(1);
    let answer: string | null = null;
    if (assistant) {
      try {
        const plaintext = openSealedEnvelope({
          key: runtime.encryptionKey,
          purpose: "ai-assistant-message",
          token: assistant.encryptedContent,
        });
        if (
          !equalAiDigest(
            assistant.contentHash,
            prefixedAiPersistenceHmac(runtime, "assistant-content", plaintext),
          )
        ) {
          return null;
        }
        answer = plaintext;
      } catch {
        return null;
      }
    }
    const citations = await database
      .select({
        claimText: aiCitations.claimText,
        locator: aiCitations.locator,
        resourceId: aiCitations.resourceId,
        resourceKind: aiCitations.resourceKind,
      })
      .from(aiCitations)
      .where(
        and(
          eq(aiCitations.workspaceId, input.workspaceId),
          eq(aiCitations.aiRunId, input.runId),
        ),
      )
      .orderBy(asc(aiCitations.createdAt), asc(aiCitations.id));
    let validatedCitations: AiRun["citations"];
    try {
      validatedCitations = validateAiCitations(citations as AiRun["citations"]);
    } catch {
      return null;
    }
    const tools = await database
      .select()
      .from(aiToolCalls)
      .where(
        and(
          eq(aiToolCalls.workspaceId, input.workspaceId),
          eq(aiToolCalls.aiRunId, input.runId),
        ),
      )
      .orderBy(asc(aiToolCalls.createdAt), asc(aiToolCalls.id));
    let toolCalls: AiToolSummary[];
    try {
      toolCalls = tools.map((tool) => ({
        approvedToolName: tool.approvedToolName,
        redactedArguments: validateRedactedToolJson(tool.redactedArguments),
        redactedResultSummary:
          tool.redactedResultSummary == null
            ? null
            : validateRedactedToolJson(tool.redactedResultSummary),
        resourceReferences: validateAiResourceReferences(
          tool.resourceReferences,
        ),
        state: tool.state,
        startedAt: tool.startedAt,
        completedAt: tool.completedAt,
      }));
    } catch {
      return null;
    }
    return Object.freeze({
      answer,
      citations: validatedCitations,
      completedAt: run.run.completedAt,
      createdAt: run.run.createdAt,
      errorCode:
        run.run.errorCode && AI_STABLE_ERROR_CODE.test(run.run.errorCode)
          ? run.run.errorCode
          : null,
      id: run.run.id,
      model: run.run.model,
      provider: run.run.provider,
      startedAt: run.run.startedAt,
      state: run.run.state,
      toolCalls: Object.freeze(toolCalls),
    });
  }

  return {
    ...worker,
    readOwnedRun,

    async insertStartedAnalysis(
      input: StartAiRowsInput,
    ): Promise<{ runId: string }> {
      const principalId = input.context.actor.principalId;
      const workspaceId = input.context.workspaceId;
      const threadId = newId();
      const messageId = newId();
      const runId = newId();
      const plaintext = canonicalAiUserMessage(input.question, input.scope);
      const now = new Date();
      await database.insert(aiThreads).values({
        id: threadId,
        workspaceId,
        ownerId: principalId,
        title: "AI analysis",
        sharing: "private",
        createdAt: now,
        createdBy: principalId,
        updatedAt: now,
        updatedBy: principalId,
      });
      await database.insert(aiMessages).values({
        id: messageId,
        workspaceId,
        threadId,
        role: "user",
        encryptedContent: sealEnvelope({
          key: runtime.encryptionKey,
          plaintext,
          purpose: "ai-user-message",
        }),
        contentHash: prefixedAiPersistenceHmac(
          runtime,
          "user-content",
          plaintext,
        ),
        createdAt: now,
        createdBy: principalId,
        updatedAt: now,
        updatedBy: principalId,
      });
      const configurationMaterial = JSON.stringify({
        baseUrlFingerprint: input.baseUrlFingerprint,
        model: input.provider.model,
        provider: input.provider.provider,
      });
      const promptHash = prefixedAiPersistenceHmac(
        runtime,
        "prompt",
        plaintext,
      );
      await database.insert(aiRuns).values({
        id: runId,
        workspaceId,
        threadId,
        messageId,
        provider: input.provider.provider,
        baseUrlFingerprint: input.baseUrlFingerprint,
        model: input.provider.model,
        capabilityProfile: { version: 1 },
        promptHash,
        configurationHash: prefixedAiPersistenceHmac(
          runtime,
          "configuration",
          configurationMaterial,
        ),
        state: "pending",
        createdAt: now,
        createdBy: principalId,
      });
      const requestHash = prefixedAiPersistenceHmac(
        runtime,
        "job-request",
        `${workspaceId}\0${principalId}\0${runId}\0${promptHash}`,
      );
      await createJobsService({
        database,
        encryptionKey: runtime.encryptionKey,
      }).enqueue({
        workspaceId,
        principalId,
        idempotencyKey: aiJobIdempotencyKey(runtime, {
          workspaceId,
          principalId,
          runId,
        }),
        payload: { kind: "ai_execute", runId },
        requestHash,
      });
      await database.insert(auditEvents).values({
        id: newId(),
        workspaceId,
        actorUserId:
          input.context.actor.type === "user" ? input.context.actor.id : null,
        sessionId:
          input.context.actor.type === "user"
            ? input.context.actor.sessionId
            : null,
        apiKeyId:
          input.context.actor.type === "apiKey" ? input.context.actor.id : null,
        action: "ai.analysis.started",
        resourceKind: "ai_run",
        resourceId: runId,
        requestId: input.context.requestId,
        redactedDiff: {
          scope: {
            evidenceCount: input.scope.evidenceIds.length,
            personCount: input.scope.personIds.length,
          },
        },
        outcome: "success",
        occurredAt: now,
      });
      return { runId };
    },

    async cancelOwnedRun(input: {
      context: ResearchServiceContext;
      runId: string;
    }): Promise<{ transitioned: boolean } | null> {
      return database.transaction(async (transactionValue) => {
        const transaction = transactionValue as unknown as Database;
        const [row] = await transaction
          .select({ run: aiRuns })
          .from(aiRuns)
          .innerJoin(
            aiThreads,
            and(
              eq(aiThreads.workspaceId, aiRuns.workspaceId),
              eq(aiThreads.id, aiRuns.threadId),
              eq(aiThreads.ownerId, input.context.actor.principalId),
              eq(aiThreads.sharing, "private"),
              isNull(aiThreads.deletedAt),
            ),
          )
          .where(
            and(
              eq(aiRuns.workspaceId, input.context.workspaceId),
              eq(aiRuns.id, input.runId),
            ),
          )
          .limit(1)
          .for("update", { of: aiRuns });
        if (!row) return null;
        if (row.run.state === "cancelled") return { transitioned: false };
        if (row.run.state !== "pending" && row.run.state !== "running") {
          return { transitioned: false };
        }
        const now = new Date();
        const [updated] = await transaction
          .update(aiRuns)
          .set({ state: "cancelled", errorCode: null, completedAt: now })
          .where(
            and(
              eq(aiRuns.workspaceId, input.context.workspaceId),
              eq(aiRuns.id, input.runId),
              inArray(aiRuns.state, ["pending", "running"]),
            ),
          )
          .returning({ id: aiRuns.id });
        if (!updated) return { transitioned: false };
        await transaction
          .update(jobs)
          .set({
            state: "dead_letter",
            errorCode: "cancelled",
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
            updatedBy: null,
          })
          .where(
            and(
              eq(jobs.workspaceId, input.context.workspaceId),
              eq(jobs.kind, "ai_execute"),
              eq(
                jobs.idempotencyKey,
                aiJobIdempotencyKey(runtime, {
                  workspaceId: input.context.workspaceId,
                  principalId: input.context.actor.principalId,
                  runId: input.runId,
                }),
              ),
              eq(jobs.state, "queued"),
            ),
          );
        await transaction.insert(auditEvents).values({
          id: newId(),
          workspaceId: input.context.workspaceId,
          actorUserId:
            input.context.actor.type === "user" ? input.context.actor.id : null,
          sessionId:
            input.context.actor.type === "user"
              ? input.context.actor.sessionId
              : null,
          apiKeyId:
            input.context.actor.type === "apiKey"
              ? input.context.actor.id
              : null,
          action: "ai.analysis.cancelled",
          resourceKind: "ai_run",
          resourceId: input.runId,
          requestId: input.context.requestId,
          redactedDiff: { state: "cancelled" },
          outcome: "success",
          occurredAt: now,
        });
        return { transitioned: true };
      });
    },
  };
}

export type {
  AiCitation,
  AiJobClaim,
  AiRepositoryRuntime,
  AiRun,
  AiScope,
  AiToolSummary,
  ClaimedAiRun,
} from "./repository-domain";
