import { builder } from "@/graphql/builder";
import type { privacyProcessorPropagations } from "@/db/schema/privacy";
import type { legalHolds } from "@/db/schema/workspaces";
import type { PrivacyRequestRow } from "./request-types";
import type { retentionDecision } from "./retention-service";

const ResourceKind = builder.enumType("PrivacyResourceKind", {
  values: { PERSON: { value: "person" }, FILE: { value: "file" } } as const,
});
const RequestType = builder.enumType("PrivacyRequestType", {
  values: {
    ACCESS: { value: "access" },
    CORRECTION: { value: "correction" },
    EXPORT: { value: "export" },
    RESTRICTION: { value: "restriction" },
    CONSENT_WITHDRAWAL: { value: "consent_withdrawal" },
    DELETION: { value: "deletion" },
  } as const,
});
const ReviewState = builder.enumType("PrivacyReviewState", {
  values: {
    REVIEWING: { value: "reviewing" },
    APPROVED: { value: "approved" },
    REJECTED: { value: "rejected" },
  } as const,
});
const Request = builder
  .objectRef<PrivacyRequestRow>("PrivacyRequest")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      requestType: t.field({
        type: RequestType,
        resolve: (r) => r.requestType,
      }),
      state: t.exposeString("state"),
      version: t.exposeInt("version"),
      dueAt: t.field({
        type: "DateTime",
        resolve: (r) => r.dueAt.toISOString(),
      }),
      executeAfter: t.field({
        type: "DateTime",
        resolve: (r) => r.executeAfter.toISOString(),
      }),
      completedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (r) => r.completedAt?.toISOString() ?? null,
      }),
      auditReference: t.expose("auditReference", {
        type: "UUID",
        nullable: true,
      }),
    }),
  });
const Requests = builder
  .objectRef<{
    nodes: PrivacyRequestRow[];
    endId: string | null;
    hasMore: boolean;
  }>("PrivacyRequestPage")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [Request], resolve: (r) => r.nodes }),
      endId: t.expose("endId", { type: "UUID", nullable: true }),
      hasMore: t.exposeBoolean("hasMore"),
    }),
  });
const Propagation = builder
  .objectRef<typeof privacyProcessorPropagations.$inferSelect>(
    "PrivacyProcessorPropagation",
  )
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      processor: t.exposeString("processor"),
      state: t.exposeString("state"),
      attempts: t.exposeInt("attempts"),
      resultCode: t.exposeString("resultCode", { nullable: true }),
      auditReference: t.expose("auditReference", {
        type: "UUID",
        nullable: true,
      }),
    }),
  });
const Hold = builder
  .objectRef<typeof legalHolds.$inferSelect & { auditReference?: string }>(
    "PrivacyLegalHold",
  )
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      state: t.exposeString("state"),
      version: t.exposeInt("version"),
      auditReference: t.field({
        type: "UUID",
        nullable: true,
        resolve: (r) => r.auditReference ?? null,
      }),
    }),
  });
const Decision = builder
  .objectRef<ReturnType<typeof retentionDecision>>("RetentionDecision")
  .implement({
    fields: (t) => ({
      state: t.exposeString("state"),
      reason: t.exposeString("reason"),
      policyId: t.expose("policyId", { type: "UUID", nullable: true }),
    }),
  });
const Create = builder.inputType("CreatePrivacyRequestInput", {
  fields: (t) => ({
    requestType: t.field({ type: RequestType, required: true }),
    personIds: t.field({ type: ["UUID"] }),
    fileIds: t.field({ type: ["UUID"] }),
    caseId: t.field({ type: "UUID" }),
    purpose: t.string(),
    dueAt: t.field({ type: "DateTime", required: true }),
    executeAfter: t.field({ type: "DateTime" }),
    idempotencyKey: t.string({ required: true }),
  }),
});

export function registerPrivacyGraphQL() {
  builder.queryFields((t) => ({
    privacyRequest: t.field({
      type: Request,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_, args, ctx) => ctx.services.privacy.getRequest(args.id),
    }),
    privacyRequests: t.field({
      type: Requests,
      args: { first: t.arg.int(), afterId: t.arg({ type: "UUID" }) },
      resolve: (_, args, ctx) => ctx.services.privacy.listRequests(args),
    }),
    privacyProcessorPropagations: t.field({
      type: [Propagation],
      args: { requestId: t.arg({ type: "UUID", required: true }) },
      resolve: (_, args, ctx) =>
        ctx.services.privacy.listPropagations(args.requestId),
    }),
    retentionDecision: t.field({
      type: Decision,
      args: {
        resourceKind: t.arg({ type: ResourceKind, required: true }),
        resourceId: t.arg({ type: "UUID", required: true }),
      },
      resolve: (_, args, ctx) => ctx.services.retention.evaluateRetention(args),
    }),
    privacyLegalHolds: t.field({
      type: [Hold],
      args: {
        resourceKind: t.arg({ type: ResourceKind, required: true }),
        resourceId: t.arg({ type: "UUID", required: true }),
        first: t.arg.int(),
      },
      resolve: (_, args, ctx) => ctx.services.retention.listLegalHolds(args),
    }),
  }));
  builder.mutationFields((t) => ({
    createPrivacyRequest: t.field({
      type: Request,
      args: { input: t.arg({ type: Create, required: true }) },
      resolve: (_, { input }, ctx) =>
        ctx.services.privacy.createRequest({
          ...input,
          personIds: input.personIds ?? [],
          fileIds: input.fileIds ?? [],
          executeAfter: input.executeAfter ?? undefined,
        }),
    }),
    reviewPrivacyRequest: t.field({
      type: Request,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        state: t.arg({ type: ReviewState, required: true }),
        verificationEvidenceId: t.arg({ type: "UUID" }),
      },
      resolve: (_, args, ctx) => ctx.services.privacy.reviewRequest(args),
    }),
    fulfillPrivacyRequest: t.field({
      type: Request,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        completionEvidenceId: t.arg({ type: "UUID" }),
      },
      resolve: (_, args, ctx) => ctx.services.privacy.fulfillRequest(args),
    }),
    cancelPrivacyRequest: t.field({
      type: Request,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
      },
      resolve: (_, args, ctx) => ctx.services.privacy.cancelRequest(args),
    }),
    createPrivacyLegalHold: t.field({
      type: Hold,
      args: {
        resourceKind: t.arg({ type: ResourceKind, required: true }),
        resourceId: t.arg({ type: "UUID", required: true }),
        reason: t.arg.string({ required: true }),
        authority: t.arg.string({ required: true }),
      },
      resolve: (_, args, ctx) => ctx.services.retention.createLegalHold(args),
    }),
    releasePrivacyLegalHold: t.field({
      type: Hold,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        reason: t.arg.string({ required: true }),
      },
      resolve: (_, args, ctx) => ctx.services.retention.releaseLegalHold(args),
    }),
  }));
}
