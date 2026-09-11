import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { normalizePagination } from "@/graphql/limits";
import type { CoverageResult } from "./types";

const Scope = builder.enumType("GovernanceScope", {
  values: {
    READ: { value: "read" },
    RESTRICTED_READ: { value: "restricted_read" },
    WRITE: { value: "write" },
    EXPORT: { value: "export" },
    AI_OPERATION: { value: "ai_operation" },
  } as const,
});
const CoverageReason = builder.enumType("ConsentCoverageReason", {
  values: {
    COVERED: { value: "covered" },
    MISSING_CONSENT: { value: "missing_consent" },
    EXPIRED: { value: "expired" },
    WITHDRAWN: { value: "withdrawn" },
    FIELD_NOT_PERMITTED: { value: "field_not_permitted" },
    CASE_NOT_PERMITTED: { value: "case_not_permitted" },
    LEGAL_HOLD: { value: "legal_hold" },
  } as const,
});
const Coverage = builder
  .objectRef<CoverageResult>("ConsentCoverage")
  .implement({
    fields: (t) => ({
      allowed: t.exposeBoolean("allowed"),
      reason: t.field({
        type: CoverageReason,
        resolve: (value) => value.reason,
      }),
      consentRecordId: t.expose("consentRecordId", {
        type: "UUID",
        nullable: true,
      }),
      policyId: t.expose("policyId", { type: "UUID", nullable: true }),
    }),
  });
const Approval = builder
  .objectRef<{
    id: string;
    state: string;
    reason: string;
    version: number;
    createdAt: Date;
  }>("AccessApproval")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      state: t.exposeString("state"),
      reason: t.exposeString("reason"),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
    }),
  });
const GovernancePageInfo = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>(
    "GovernancePageInfo",
  )
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });
const ApprovalConnection = builder
  .objectRef<{
    nodes: {
      id: string;
      state: string;
      reason: string;
      version: number;
      createdAt: Date;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("AccessApprovalConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", { type: [Approval] }),
      pageInfo: t.field({
        type: GovernancePageInfo,
        resolve: (row) => row.pageInfo,
      }),
    }),
  });

export function registerGovernanceGraphQL() {
  builder.queryFields((t) => ({
    consentCoverage: t.field({
      type: Coverage,
      args: {
        personId: t.arg({ type: "UUID", required: true }),
        purpose: t.arg.string({ required: true }),
        scope: t.arg({ type: Scope, required: true }),
        fieldDefinitionId: t.arg({ type: "UUID" }),
        caseReference: t.arg.string(),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "person", "read");
        return context.services.governance.getCoverage(args);
      },
    }),
    accessApprovals: t.field({
      type: ApprovalConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 1,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "read");
        return context.services.governance.listApprovals(args);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    withdrawConsent: t.field({
      type: Approval,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
      },
      resolve: async (_root, args, context) =>
        context.services.governance.withdrawConsent(args) as never,
    }),
    requestAccessApproval: t.field({
      type: Approval,
      args: {
        personId: t.arg({ type: "UUID", required: true }),
        fieldDefinitionId: t.arg({ type: "UUID", required: true }),
        purpose: t.arg.string({ required: true }),
        reason: t.arg.string({ required: true }),
        caseReference: t.arg.string(),
      },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "read");
        return context.services.governance.requestApproval(args) as never;
      },
    }),
    reviewAccessApproval: t.field({
      type: Approval,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        state: t.arg.string({ required: true }),
        reason: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, context) =>
        context.services.governance.reviewApproval({
          ...args,
          state: args.state as "approved" | "rejected" | "revoked",
        }) as never,
    }),
  }));
}
