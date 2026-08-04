import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import type { OperationLimitPolicy } from "@/graphql/operation-limiter";
import { PageInfo } from "@/modules/people/graphql";
import type { PageInfo as PageInfoShape } from "@/modules/people/service";

import {
  isAiStableErrorCode,
  type AiRun,
  type AiRunHistoryItem,
  type AiToolSummary,
} from "./repository-domain";

const AiProvider = builder.enumType("AiProvider", {
  values: ["OPENAI", "OLLAMA", "COMPATIBLE"] as const,
});
const AiRunState = builder.enumType("AiRunState", {
  values: {
    CANCELLED: { value: "cancelled" },
    COMPLETED: { value: "completed" },
    FAILED: { value: "failed" },
    PENDING: { value: "pending" },
    RUNNING: { value: "running" },
  } as const,
});
const AiFailureCode = builder.enumType("AiFailureCode", {
  values: {
    ANALYSIS_CANCELLED: { value: "analysis_cancelled" },
    ANALYSIS_LIMIT_REACHED: { value: "analysis_limit_reached" },
    AUTHORIZATION_CHANGED: { value: "authorization_changed" },
    EXECUTION_FAILED: { value: "execution_failed" },
    INPUT_UNAVAILABLE: { value: "input_unavailable" },
    PROVIDER_INVALID_RESPONSE: { value: "provider_invalid_response" },
    PROVIDER_RESPONSE_TOO_LARGE: { value: "provider_response_too_large" },
    PROVIDER_TIMEOUT: { value: "provider_timeout" },
    PROVIDER_UNAVAILABLE: { value: "provider_unavailable" },
  } as const,
});
const AiResourceKind = builder.enumType("AiResourceKind", {
  values: {
    EVIDENCE: { value: "evidence" },
    PERSON: { value: "person" },
  } as const,
});
const AiToolState = builder.enumType("AiToolState", {
  values: {
    COMPLETED: { value: "completed" },
    FAILED: { value: "failed" },
    PENDING: { value: "pending" },
    RUNNING: { value: "running" },
  } as const,
});

type RedactedCountSummary = Readonly<Record<string, unknown>>;

function summaryInteger(
  summary: RedactedCountSummary,
  key: string,
): number | null {
  const value = summary[key];
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function summaryBoolean(
  summary: RedactedCountSummary,
  key: string,
): boolean | null {
  const value = summary[key];
  return typeof value === "boolean" ? value : null;
}

const AiToolCountSummary = builder
  .objectRef<RedactedCountSummary>("AiToolCountSummary")
  .implement({
    fields: (t) => ({
      evidenceCount: t.int({
        nullable: true,
        resolve: (summary) => summaryInteger(summary, "evidenceCount"),
      }),
      filterCount: t.int({
        nullable: true,
        resolve: (summary) => summaryInteger(summary, "filterCount"),
      }),
      personCount: t.int({
        nullable: true,
        resolve: (summary) => summaryInteger(summary, "personCount"),
      }),
      resourceCount: t.int({
        nullable: true,
        resolve: (summary) => summaryInteger(summary, "resourceCount"),
      }),
      resultCount: t.int({
        nullable: true,
        resolve: (summary) => summaryInteger(summary, "resultCount"),
      }),
      truncated: t.boolean({
        nullable: true,
        resolve: (summary) => summaryBoolean(summary, "truncated"),
      }),
    }),
  });

const AiCitation = builder
  .objectRef<AiRun["citations"][number]>("AiCitation")
  .implement({
    fields: (t) => ({
      claimText: t.exposeString("claimText"),
      locator: t.exposeString("locator", { nullable: true }),
      resourceId: t.expose("resourceId", { type: "UUID" }),
      resourceKind: t.field({
        type: AiResourceKind,
        resolve: (citation) => citation.resourceKind,
      }),
    }),
  });

const AiToolCall = builder.objectRef<AiToolSummary>("AiToolCall").implement({
  fields: (t) => ({
    name: t.string({ resolve: (tool) => tool.approvedToolName }),
    state: t.field({
      type: AiToolState,
      resolve: (tool) =>
        tool.state as "completed" | "failed" | "pending" | "running",
    }),
    inputSummary: t.field({
      type: AiToolCountSummary,
      resolve: (tool) => tool.redactedArguments,
    }),
    resultSummary: t.field({
      type: AiToolCountSummary,
      nullable: true,
      resolve: (tool) => tool.redactedResultSummary,
    }),
    startedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (tool) => tool.startedAt?.toISOString() ?? null,
    }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (tool) => tool.completedAt?.toISOString() ?? null,
    }),
  }),
});

const AiRunType = builder.objectRef<AiRun>("AiRun").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    state: t.field({ type: AiRunState, resolve: (run) => run.state }),
    provider: t.field({ type: AiProvider, resolve: (run) => run.provider }),
    model: t.exposeString("model"),
    answer: t.exposeString("answer", { nullable: true }),
    errorCode: t.field({
      type: AiFailureCode,
      nullable: true,
      resolve: (run) =>
        isAiStableErrorCode(run.errorCode) ? run.errorCode : null,
    }),
    createdAt: t.field({
      type: "DateTime",
      resolve: (run) => run.createdAt.toISOString(),
    }),
    startedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (run) => run.startedAt?.toISOString() ?? null,
    }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (run) => run.completedAt?.toISOString() ?? null,
    }),
    citations: t.expose("citations", {
      type: [AiCitation],
      complexity: { field: 0, multiplier: 1 },
    }),
    toolCalls: t.expose("toolCalls", {
      type: [AiToolCall],
      complexity: { field: 0, multiplier: 1 },
    }),
  }),
});

const AiRunHistoryItemType = builder
  .objectRef<AiRunHistoryItem>("AiRunHistoryItem")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      state: t.field({ type: AiRunState, resolve: (run) => run.state }),
      provider: t.field({ type: AiProvider, resolve: (run) => run.provider }),
      model: t.exposeString("model"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (run) => run.createdAt.toISOString(),
      }),
      startedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (run) => run.startedAt?.toISOString() ?? null,
      }),
      completedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (run) => run.completedAt?.toISOString() ?? null,
      }),
    }),
  });

const AiRunHistoryConnection = builder
  .objectRef<{ nodes: AiRunHistoryItem[]; pageInfo: PageInfoShape }>(
    "AiRunHistoryConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [AiRunHistoryItemType],
        nullable: false,
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });

const AiAnalysisScopeInput = builder.inputType("AiAnalysisScopeInput", {
  fields: (t) => ({
    evidenceIds: t.field({ type: ["UUID"] }),
    personIds: t.field({ type: ["UUID"] }),
  }),
});
const StartAiAnalysisInput = builder.inputType("StartAiAnalysisInput", {
  fields: (t) => ({
    idempotencyKey: t.string({ required: true }),
    question: t.string({ required: true }),
    scope: t.field({ type: AiAnalysisScopeInput }),
  }),
});

const AI_WRITE_POLICY: OperationLimitPolicy = {
  capacity: 1_000,
  refillAmount: 1_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
};
const AI_READ_POLICY: OperationLimitPolicy = {
  capacity: 10_000,
  refillAmount: 10_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
};

function notFound(): never {
  throw createGraphQLError("NOT_FOUND", "The requested AI run was not found.");
}

export function registerAiGraphQL(): void {
  builder.queryFields((t) => ({
    aiRun: t.field({
      type: AiRunType,
      args: { id: t.arg({ type: "UUID", required: true }) },
      complexity: { field: 40 },
      resolve: async (_root, args, context) => {
        requirePermission(context, "analysis", "read");
        await context.operationLimiter.consume({
          operationClass: "ai.analysis.read",
          cost: 1,
          clientPolicy: AI_READ_POLICY,
          policy: AI_READ_POLICY,
        });
        return (await context.services.ai.readAiRun(args.id)) ?? notFound();
      },
    }),
    dashboardRecentAiAnalyses: t.field({
      type: AiRunHistoryConnection,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier:
          args.first == null
            ? 5
            : Number.isInteger(args.first) &&
                args.first >= 1 &&
                args.first <= 10
              ? args.first
              : 11,
      }),
      resolve: async (_root, args, context) => {
        requirePermission(context, "analysis", "read");
        const cost =
          args.first == null
            ? 5
            : Number.isInteger(args.first) &&
                args.first >= 1 &&
                args.first <= 10
              ? args.first
              : 11;
        await context.operationLimiter.consume({
          operationClass: "ai.analysis.history",
          cost,
          clientPolicy: AI_READ_POLICY,
          policy: AI_READ_POLICY,
        });
        return context.services.ai.listOwnedRuns(args);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    startAiAnalysis: t.field({
      type: AiRunType,
      args: {
        input: t.arg({ type: StartAiAnalysisInput, required: true }),
      },
      complexity: { field: 40 },
      resolve: async (_root, args, context) => {
        requirePermission(context, "analysis", "create");
        requirePermission(context, "analysis", "run");
        await context.operationLimiter.consume({
          operationClass: "ai.analysis.start",
          cost: 25,
          clientPolicy: AI_WRITE_POLICY,
          policy: AI_WRITE_POLICY,
        });
        return context.services.ai.startAiAnalysis({
          idempotencyKey: args.input.idempotencyKey,
          question: args.input.question,
          ...(args.input.scope
            ? {
                scope: {
                  evidenceIds: args.input.scope.evidenceIds ?? [],
                  personIds: args.input.scope.personIds ?? [],
                },
              }
            : {}),
        });
      },
    }),
    cancelAiAnalysis: t.field({
      type: AiRunType,
      args: { id: t.arg({ type: "UUID", required: true }) },
      complexity: { field: 40 },
      resolve: async (_root, args, context) => {
        requirePermission(context, "analysis", "cancel");
        await context.operationLimiter.consume({
          operationClass: "ai.analysis.cancel",
          cost: 2,
          clientPolicy: AI_WRITE_POLICY,
          policy: AI_WRITE_POLICY,
        });
        return (await context.services.ai.cancelAiRun(args.id)) ?? notFound();
      },
    }),
  }));
}
