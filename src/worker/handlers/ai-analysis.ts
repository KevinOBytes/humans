import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  equalAiDigest,
  mapAiFailureCode,
  prefixedAiPersistenceHmac,
  type AiCitation,
  type AiJobClaim,
} from "@/modules/ai/repository-domain";
import { createAiRepository } from "@/modules/ai/repository";
import {
  RESEARCH_TOOL_NAMES,
  invokeResearchTool,
  type ResearchToolName,
  type ResearchToolResult,
  type ResearchTools,
} from "@/modules/ai/tools";
import type {
  AiProvider,
  AiProviderMessage,
  AiToolDeclaration,
} from "@/modules/ai/provider";
import {
  JobExecutionError,
  MAX_JOB_ATTEMPTS,
  type JobPayload,
} from "@/modules/jobs/types";
import type { JobHandler, JobHandlerContext } from "@/worker/registry";

const MAX_PROVIDER_BOUNDARIES = 4;
const MAX_TOOL_BOUNDARIES = 4;

const TOOL_DECLARATIONS: readonly AiToolDeclaration[] = Object.freeze([
  Object.freeze({
    name: "getEvidence",
    description: "Read one evidence item from the authorized run scope.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: { evidenceId: { type: "string", format: "uuid" } },
      required: ["evidenceId"],
    }),
  }),
  Object.freeze({
    name: "getPerson",
    description: "Read one person from the authorized run scope.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: { personId: { type: "string", format: "uuid" } },
      required: ["personId"],
    }),
  }),
  Object.freeze({
    name: "searchGraph",
    description: "Read a bounded graph neighborhood in the run scope.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: {
        personIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
          minItems: 1,
          maxItems: 20,
        },
        depth: { type: "integer", minimum: 1, maximum: 2 },
      },
      required: ["personIds"],
    }),
  }),
  Object.freeze({
    name: "searchPeople",
    description: "Search for people inside the authorized run scope.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        personIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["query"],
    }),
  }),
]);

type AiRepository = ReturnType<typeof createAiRepository>;
export type AuthorizedClaimedAiRun = NonNullable<
  Awaited<ReturnType<AiRepository["authorizeClaimedRun"]>>
>;

export type AiAnalysisHandlerRuntime = Readonly<{
  createTools(input: AuthorizedClaimedAiRun): ResearchTools;
  database: Database;
  encryptionKey: string;
  hmacKey: string;
  provider: AiProvider;
}>;

type CitationLedger = Map<string, "evidence" | "person">;

function isResearchToolName(value: string): value is ResearchToolName {
  return (RESEARCH_TOOL_NAMES as readonly string[]).includes(value);
}

function ownCode(error: unknown): unknown {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor && "value" in descriptor ? descriptor.value : null;
}

function retryableProviderCode(code: unknown): boolean {
  return (
    code === "PROVIDER_TIMEOUT" ||
    code === "PROVIDER_UNAVAILABLE" ||
    code === "PROVIDER_RESPONSE_INVALID"
  );
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? Math.min(value.length, 10_000) : 0;
}

function redactedArguments(
  name: ResearchToolName,
  input: Readonly<Record<string, unknown>>,
  run: AuthorizedClaimedAiRun["run"],
): Readonly<Record<string, unknown>> {
  switch (name) {
    case "getEvidence":
      return Object.freeze({ evidenceCount: 1 });
    case "getPerson":
      return Object.freeze({ personCount: 1 });
    case "searchGraph":
      return Object.freeze({ personCount: countArray(input.personIds) });
    case "searchPeople":
      return Object.freeze({
        filterCount: 1,
        personCount: Array.isArray(input.personIds)
          ? countArray(input.personIds)
          : run.scope.personIds.length,
      });
  }
}

function redactedResult(result: ResearchToolResult) {
  const evidence = new Set(result.evidenceIds);
  const personCount = result.resourceIds.filter(
    (id) => !evidence.has(id),
  ).length;
  const summary: Record<string, number | boolean> = {
    ...(result.evidenceIds.length
      ? { evidenceCount: result.evidenceIds.length }
      : {}),
    ...(personCount ? { personCount } : {}),
    resultCount: result.resourceIds.length,
  };
  if (
    result.ok &&
    Object.hasOwn(result.summary, "truncated") &&
    typeof result.summary.truncated === "boolean"
  ) {
    summary.truncated = result.summary.truncated;
  }
  return Object.freeze(summary);
}

function references(result: ResearchToolResult) {
  if (!result.ok) return Object.freeze([]);
  const evidenceIds = new Set(result.evidenceIds);
  return Object.freeze(
    result.resourceIds.map((id) => ({
      id,
      kind: evidenceIds.has(id) ? ("evidence" as const) : ("person" as const),
    })),
  );
}

function providerToolResult(result: ResearchToolResult): string {
  return JSON.stringify({
    code: result.code,
    ok: result.ok,
    summary: result.summary,
  });
}

function citations(
  answer: string,
  candidates: readonly Readonly<{
    evidenceId?: string;
    excerpt?: string;
    resourceId: string;
  }>[],
  ledger: CitationLedger,
): readonly AiCitation[] | null {
  const validated: AiCitation[] = [];
  for (const candidate of candidates) {
    if (!ledger.has(candidate.resourceId)) return null;
    const resourceId = candidate.evidenceId ?? candidate.resourceId;
    const kind = ledger.get(resourceId);
    if (!kind || (candidate.evidenceId && kind !== "evidence")) return null;
    const claimText = (candidate.excerpt ?? answer).normalize("NFKC").trim();
    if (
      Buffer.byteLength(claimText, "utf8") < 1 ||
      Buffer.byteLength(claimText, "utf8") > 2_000
    ) {
      return null;
    }
    validated.push({
      claimText,
      locator: null,
      resourceId,
      resourceKind: kind,
    });
  }
  return Object.freeze(validated);
}

function claim(
  payload: Extract<JobPayload, { kind: "ai_execute" }>,
  context: JobHandlerContext,
): AiJobClaim | null {
  if (!context.job.leaseOwner) return null;
  return Object.freeze({
    claimGeneration: context.job.claimGeneration,
    jobId: context.job.id,
    leaseOwner: context.job.leaseOwner,
    runId: payload.runId,
    workspaceId: context.job.workspaceId,
  });
}

export function createAiAnalysisHandler(
  runtime: AiAnalysisHandlerRuntime,
): JobHandler<Extract<JobPayload, { kind: "ai_execute" }>> {
  const repository = createAiRepository(runtime.database, {
    encryptionKey: runtime.encryptionKey,
    hmacKey: runtime.hmacKey,
  });

  return async (payload, context) => {
    const jobClaim = claim(payload, context);
    if (!jobClaim) throw new JobExecutionError("lease_lost", "retryable");

    const ensureLease = async () => {
      if (context.signal.aborted) {
        throw new JobExecutionError("analysis_cancelled", "retryable");
      }
      if (!(await context.renewLease())) {
        throw new JobExecutionError("lease_lost", "retryable");
      }
    };
    const persistFailure = async (
      errorCode: ReturnType<typeof mapAiFailureCode>,
      failureKind: "permanent" | "retryable",
      persist: boolean,
    ): Promise<never> => {
      if (context.signal.aborted) {
        throw new JobExecutionError("analysis_cancelled", "retryable");
      }
      if (persist) {
        const recorded = await repository.recordClaimedFailure({
          ...jobClaim,
          errorCode,
        });
        if (!recorded) {
          if (!(await context.renewLease())) {
            throw new JobExecutionError("lease_lost", "retryable");
          }
          throw new JobExecutionError("analysis_cancelled", "permanent");
        }
      }
      throw new JobExecutionError(errorCode, failureKind);
    };
    const authorize = async (): Promise<AuthorizedClaimedAiRun> => {
      await ensureLease();
      const authorized = await repository.authorizeClaimedRun(jobClaim);
      if (authorized) return authorized;
      return persistFailure("authorization_changed", "permanent", true);
    };

    await ensureLease();
    const run = await repository.loadClaimedPendingRun(jobClaim);
    if (!run) {
      if (await repository.isClaimedRunCompleted(jobClaim)) {
        return { resultReferences: [payload.runId] };
      }
      return persistFailure("input_unavailable", "permanent", true);
    }
    const configurationHash = prefixedAiPersistenceHmac(
      { encryptionKey: runtime.encryptionKey, hmacKey: runtime.hmacKey },
      "configuration",
      JSON.stringify({
        baseUrlFingerprint: runtime.provider.baseUrlFingerprint,
        model: runtime.provider.disclosure.model,
        provider: runtime.provider.disclosure.provider,
      }),
    );
    if (
      run.model !== runtime.provider.disclosure.model ||
      run.provider !== runtime.provider.disclosure.provider ||
      !equalAiDigest(run.configurationHash, configurationHash)
    ) {
      return persistFailure("input_unavailable", "permanent", true);
    }

    const messages: AiProviderMessage[] = [
      {
        role: "system",
        content:
          "Use only the declared read tools. Cite only resources returned by those tools.",
      },
      { role: "user", content: run.question },
    ];
    const ledger: CitationLedger = new Map();
    let toolBoundaries = 0;

    for (let depth = 0; depth < MAX_PROVIDER_BOUNDARIES; depth += 1) {
      await authorize();
      let turn;
      try {
        turn = await runtime.provider.generate({
          messages,
          signal: context.signal,
          toolLoopDepth: depth,
          tools: TOOL_DECLARATIONS,
        });
      } catch (error) {
        const code = ownCode(error);
        const mapped = mapAiFailureCode(code);
        const retryable = retryableProviderCode(code);
        return persistFailure(
          mapped,
          retryable ? "retryable" : "permanent",
          !retryable || context.job.attemptCount >= MAX_JOB_ATTEMPTS,
        );
      }

      if (turn.type === "answer") {
        await authorize();
        const validatedCitations = citations(
          turn.answer,
          turn.citations,
          ledger,
        );
        if (!validatedCitations) {
          return persistFailure("provider_invalid_response", "permanent", true);
        }
        const finalized = await repository.finalizeClaimedRun({
          ...jobClaim,
          answer: turn.answer,
          citations: validatedCitations,
        });
        if (!finalized) {
          if (!(await context.renewLease())) {
            throw new JobExecutionError("lease_lost", "retryable");
          }
          throw new JobExecutionError("analysis_cancelled", "permanent");
        }
        return { resultReferences: [payload.runId] };
      }

      if (
        !turn.toolCalls.length ||
        toolBoundaries + turn.toolCalls.length > MAX_TOOL_BOUNDARIES
      ) {
        return persistFailure("analysis_limit_reached", "permanent", true);
      }
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: turn.toolCalls,
      });
      for (const toolCall of turn.toolCalls) {
        toolBoundaries += 1;
        if (!isResearchToolName(toolCall.name)) {
          return persistFailure("provider_invalid_response", "permanent", true);
        }
        const authorized = await authorize();
        const tools = runtime.createTools(authorized);
        const result = await invokeResearchTool(
          tools,
          toolCall.name,
          toolCall.arguments,
        );
        await ensureLease();
        const resourceReferences = references(result);
        const recorded = await repository.recordClaimedToolCall({
          ...jobClaim,
          approvedToolName: toolCall.name.toLowerCase(),
          redactedArguments: redactedArguments(
            toolCall.name,
            toolCall.arguments,
            authorized.run,
          ),
          redactedResultSummary: redactedResult(result),
          resourceReferences,
        });
        if (!recorded) {
          await authorize();
          throw new JobExecutionError("lease_lost", "retryable");
        }
        for (const reference of resourceReferences) {
          ledger.set(reference.id, reference.kind);
        }
        messages.push({
          role: "tool",
          content: providerToolResult(result),
          name: toolCall.name,
          toolCallId: toolCall.id,
        });
      }
    }

    return persistFailure("analysis_limit_reached", "permanent", true);
  };
}
