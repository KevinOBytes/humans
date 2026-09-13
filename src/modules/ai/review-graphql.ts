import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { normalizePagination } from "@/graphql/limits";
import { PageInfo } from "@/modules/people/graphql";
import type {
  AcceptedAiEvidenceReference,
  AcceptedAiHistoryConnection,
  AcceptedAiHistoryItem,
  AiReviewSuggestion,
} from "./review-service";

const Suggestion = builder
  .objectRef<AiReviewSuggestion>("AiReviewSuggestion")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID", nullable: false }),
      personId: t.expose("personId", { type: "UUID", nullable: false }),
      caseId: t.expose("caseId", { type: "UUID", nullable: true }),
      purpose: t.exposeString("purpose", { nullable: false }),
      fieldKey: t.exposeString("fieldKey", { nullable: false }),
      proposedValue: t.expose("proposedValue", {
        type: "JSON",
        nullable: false,
      }),
      currentValue: t.exposeString("currentValue", { nullable: true }),
      evidenceReferences: t.expose("evidenceReferences", {
        type: "JSON",
        nullable: false,
      }),
      confidence: t.exposeFloat("confidence", { nullable: false }),
      uncertainty: t.exposeString("uncertainty", { nullable: false }),
      provider: t.exposeString("provider", { nullable: false }),
      model: t.exposeString("model", { nullable: false }),
      researchRunId: t.expose("researchRunId", {
        type: "UUID",
        nullable: false,
      }),
      promptPolicyVersion: t.exposeString("promptPolicyVersion", {
        nullable: false,
      }),
      status: t.exposeString("status", { nullable: false }),
      version: t.exposeInt("version", { nullable: false }),
      acceptedResourceId: t.expose("acceptedResourceId", {
        type: "UUID",
        nullable: true,
      }),
      acceptedResourceKind: t.exposeString("acceptedResourceKind", {
        nullable: true,
      }),
      acceptedFromRunId: t.expose("acceptedFromRunId", {
        type: "UUID",
        nullable: true,
      }),
      acceptedEvidenceReferences: t.expose("acceptedEvidenceReferences", {
        type: "JSON",
        nullable: true,
      }),
      decisionReason: t.exposeString("decisionReason", { nullable: true }),
      reviewedBy: t.expose("reviewedBy", { type: "UUID", nullable: true }),
      reviewedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (s) => s.reviewedAt?.toISOString() ?? null,
      }),
    }),
  });

const AcceptedEvidenceReference = builder
  .objectRef<AcceptedAiEvidenceReference>("AcceptedAiEvidenceReference")
  .implement({
    fields: (t) => ({
      kind: t.exposeString("kind", { nullable: false }),
      evidenceId: t.expose("evidenceId", { type: "UUID", nullable: true }),
      url: t.exposeString("url", { nullable: true }),
      locator: t.exposeString("locator", { nullable: true }),
      quote: t.exposeString("quote", { nullable: true }),
      snapshotHash: t.exposeString("snapshotHash", { nullable: true }),
      redacted: t.exposeBoolean("redacted", { nullable: false }),
    }),
  });

const AcceptedResourceReference = builder
  .objectRef<AcceptedAiHistoryItem["acceptedResource"]>(
    "AcceptedAiResourceReference",
  )
  .implement({
    fields: (t) => ({
      kind: t.exposeString("kind", { nullable: false }),
      id: t.expose("id", { type: "UUID", nullable: true }),
      redacted: t.exposeBoolean("redacted", { nullable: false }),
    }),
  });

const AcceptedHistoryItem = builder
  .objectRef<AcceptedAiHistoryItem>("AcceptedAiResearchHistoryItem")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID", nullable: false }),
      personId: t.expose("personId", { type: "UUID", nullable: false }),
      caseId: t.expose("caseId", { type: "UUID", nullable: true }),
      purpose: t.exposeString("purpose", { nullable: false }),
      fieldKey: t.exposeString("fieldKey", { nullable: false }),
      confidence: t.exposeFloat("confidence", { nullable: false }),
      uncertainty: t.exposeString("uncertainty", { nullable: false }),
      provider: t.exposeString("provider", { nullable: false }),
      model: t.exposeString("model", { nullable: false }),
      promptPolicyVersion: t.exposeString("promptPolicyVersion", {
        nullable: false,
      }),
      researchRunId: t.expose("researchRunId", {
        type: "UUID",
        nullable: false,
      }),
      reviewerPrincipalId: t.expose("reviewerPrincipalId", {
        type: "UUID",
        nullable: false,
      }),
      suggestedAt: t.field({
        type: "DateTime",
        nullable: false,
        resolve: (row) => row.suggestedAt.toISOString(),
      }),
      reviewedAt: t.field({
        type: "DateTime",
        nullable: false,
        resolve: (row) => row.reviewedAt.toISOString(),
      }),
      decisionReason: t.exposeString("decisionReason", { nullable: true }),
      acceptedResource: t.field({
        type: AcceptedResourceReference,
        nullable: false,
        resolve: (row) => row.acceptedResource,
      }),
      evidenceReferences: t.field({
        type: [AcceptedEvidenceReference],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
        resolve: (row) => row.evidenceReferences,
      }),
    }),
  });

const AcceptedHistoryConnection = builder
  .objectRef<AcceptedAiHistoryConnection>("AcceptedAiResearchHistoryConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({
        type: [AcceptedHistoryItem],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
        resolve: (connection) => connection.nodes,
      }),
      pageInfo: t.field({
        type: PageInfo,
        nullable: false,
        resolve: (connection) => connection.pageInfo,
      }),
    }),
  });
const AcceptInput = builder.inputType("AcceptAiSuggestionInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    explicitConfirmed: t.boolean({ required: true }),
  }),
});
const RejectInput = builder.inputType("RejectAiSuggestionInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    reason: t.string({ required: true }),
  }),
});
const DeferInput = builder.inputType("DeferAiSuggestionInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const BatchItem = builder.inputType("AiReviewBatchItem", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const BatchInput = builder.inputType("AiReviewBatchInput", {
  fields: (t) => ({
    suggestions: t.field({ type: [BatchItem], required: true }),
    approved: t.boolean({ required: true }),
  }),
});
export function registerAiReviewGraphQL() {
  builder.queryFields((t) => ({
    pendingAiSuggestions: t.field({
      type: [Suggestion],
      nullable: false,
      complexity: { field: 50 },
      args: {
        personId: t.arg({ type: "UUID", required: true }),
        purpose: t.arg.string({ required: true }),
        caseId: t.arg({ type: "UUID" }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "analysis", "read");
        return context.services.aiReview.listSuggestions(args);
      },
    }),
    acceptedAiResearchHistory: t.field({
      type: AcceptedHistoryConnection,
      nullable: false,
      args: {
        personId: t.arg({ type: "UUID", required: true }),
        purpose: t.arg.string({ required: true }),
        caseId: t.arg({ type: "UUID" }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => ({
        field: 1,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) => {
        requirePermission(context, "analysis", "read");
        return context.services.aiReview.listAcceptedHistory(args);
      },
    }),
    aiSuggestion: t.field({
      type: Suggestion,
      nullable: false,
      complexity: { field: 20 },
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) =>
        context.services.aiReview.getSuggestion(args.id),
    }),
  }));
  builder.mutationFields((t) => ({
    acceptAiSuggestion: t.field({
      type: Suggestion,
      nullable: false,
      complexity: { field: 50 },
      args: { input: t.arg({ type: AcceptInput, required: true }) },
      resolve: (_root, args, context) =>
        context.services.aiReview.acceptSuggestion(args.input),
    }),
    rejectAiSuggestion: t.field({
      type: Suggestion,
      nullable: false,
      complexity: { field: 20 },
      args: { input: t.arg({ type: RejectInput, required: true }) },
      resolve: (_root, args, context) =>
        context.services.aiReview.rejectSuggestion(args.input),
    }),
    deferAiSuggestion: t.field({
      type: Suggestion,
      nullable: false,
      complexity: { field: 20 },
      args: { input: t.arg({ type: DeferInput, required: true }) },
      resolve: (_root, args, context) =>
        context.services.aiReview.deferSuggestion(args.input),
    }),
    reviewAiBatch: t.field({
      type: [Suggestion],
      nullable: false,
      complexity: { field: 100 },
      args: { input: t.arg({ type: BatchInput, required: true }) },
      resolve: (_root, args, context) =>
        context.services.aiReview.reviewBatch(args.input),
    }),
  }));
}
