import { builder } from "@/graphql/builder";
import { normalizePagination } from "@/graphql/limits";
import type {
  ResearchAssignmentEventRow,
  ResearchAssignmentItemRow,
} from "@/db/schema/research-assignments";

const QueueKind = builder.enumType("ResearchAssignmentQueueKind", {
  values: {
    REVIEW: { value: "review" },
    VERIFICATION: { value: "verification" },
    CONSENT_FOLLOW_UP: { value: "consent_follow_up" },
    SOURCE_RECONCILIATION: { value: "source_reconciliation" },
    PRIVACY_REQUEST: { value: "privacy_request" },
  } as const,
});
const AssignmentStatus = builder.enumType("ResearchAssignmentStatus", {
  values: {
    OPEN: { value: "open" },
    IN_PROGRESS: { value: "in_progress" },
    BLOCKED: { value: "blocked" },
    COMPLETED: { value: "completed" },
    CANCELLED: { value: "cancelled" },
  } as const,
});
const Assignment = builder
  .objectRef<ResearchAssignmentItemRow>("ResearchAssignment")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      caseId: t.expose("caseId", { type: "UUID", nullable: true }),
      queueKind: t.field({
        type: QueueKind,
        resolve: (r) => r.queueKind as never,
      }),
      title: t.exposeString("title"),
      description: t.exposeString("description", { nullable: true }),
      priority: t.exposeInt("priority"),
      status: t.field({
        type: AssignmentStatus,
        resolve: (r) => r.status as never,
      }),
      assigneePrincipalId: t.expose("assigneePrincipalId", {
        type: "UUID",
        nullable: true,
      }),
      dueAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (r) => r.dueAt?.toISOString() ?? null,
      }),
      escalationCount: t.exposeInt("escalationCount"),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (r) => r.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (r) => r.updatedAt.toISOString(),
      }),
    }),
  });
const AssignmentEvent = builder
  .objectRef<ResearchAssignmentEventRow>("ResearchAssignmentEvent")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      assignmentId: t.expose("assignmentId", { type: "UUID" }),
      eventKind: t.exposeString("eventKind"),
      fromStatus: t.exposeString("fromStatus", { nullable: true }),
      toStatus: t.exposeString("toStatus", { nullable: true }),
      fromAssigneePrincipalId: t.expose("fromAssigneePrincipalId", {
        type: "UUID",
        nullable: true,
      }),
      toAssigneePrincipalId: t.expose("toAssigneePrincipalId", {
        type: "UUID",
        nullable: true,
      }),
      reason: t.exposeString("reason", { nullable: true }),
      actorPrincipalId: t.expose("actorPrincipalId", { type: "UUID" }),
      occurredAt: t.field({
        type: "DateTime",
        resolve: (r) => r.occurredAt.toISOString(),
      }),
    }),
  });
const PageInfo = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>(
    "ResearchAssignmentPageInfo",
  )
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });
const AssignmentConnection = builder
  .objectRef<{
    nodes: ResearchAssignmentItemRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("ResearchAssignmentConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [Assignment], resolve: (r) => r.nodes }),
      pageInfo: t.field({ type: PageInfo, resolve: (r) => r.pageInfo }),
    }),
  });
const AssignmentPayload = builder
  .objectRef<{ assignment: ResearchAssignmentItemRow }>(
    "ResearchAssignmentPayload",
  )
  .implement({
    fields: (t) => ({
      assignment: t.field({ type: Assignment, resolve: (r) => r.assignment }),
    }),
  });

const CreateInput = builder.inputType("CreateResearchAssignmentInput", {
  fields: (t) => ({
    caseId: t.field({ type: "UUID" }),
    queueKind: t.field({ type: QueueKind, required: true }),
    title: t.string({ required: true }),
    description: t.string(),
    priority: t.int(),
    assigneePrincipalId: t.field({ type: "UUID" }),
    dueAt: t.field({ type: "DateTime" }),
    idempotencyKey: t.string({ required: true }),
  }),
});
const AssignInput = builder.inputType("AssignResearchAssignmentInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    assigneePrincipalId: t.field({ type: "UUID" }),
    reason: t.string({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});
const TransitionInput = builder.inputType("TransitionResearchAssignmentInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    status: t.field({ type: AssignmentStatus, required: true }),
    reason: t.string({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});
const EscalateInput = builder.inputType("EscalateResearchAssignmentInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    reason: t.string({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});

export function registerResearchAssignmentsGraphQL() {
  builder.queryFields((t) => ({
    researchAssignments: t.field({
      type: AssignmentConnection,
      args: {
        caseId: t.arg({ type: "UUID" }),
        status: t.arg({ type: AssignmentStatus }),
        queueKind: t.arg({ type: QueueKind }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => ({
        field: 1,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) =>
        context.services.researchAssignments.list(args),
    }),
    researchAssignment: t.field({
      type: Assignment,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) =>
        context.services.researchAssignments.get(args.id),
    }),
    researchAssignmentEvents: t.field({
      type: [AssignmentEvent],
      args: { assignmentId: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) =>
        context.services.researchAssignments.events(args.assignmentId),
    }),
  }));
  builder.mutationFields((t) => ({
    createResearchAssignment: t.field({
      type: AssignmentPayload,
      args: { input: t.arg({ type: CreateInput, required: true }) },
      resolve: async (_root, args, context) => ({
        assignment: await context.services.researchAssignments.create(
          args.input,
        ),
      }),
    }),
    assignResearchAssignment: t.field({
      type: AssignmentPayload,
      args: { input: t.arg({ type: AssignInput, required: true }) },
      resolve: async (_root, args, context) => ({
        assignment: await context.services.researchAssignments.assign(
          args.input,
        ),
      }),
    }),
    transitionResearchAssignment: t.field({
      type: AssignmentPayload,
      args: { input: t.arg({ type: TransitionInput, required: true }) },
      resolve: async (_root, args, context) => ({
        assignment: await context.services.researchAssignments.transition(
          args.input,
        ),
      }),
    }),
    escalateResearchAssignment: t.field({
      type: AssignmentPayload,
      args: { input: t.arg({ type: EscalateInput, required: true }) },
      resolve: async (_root, args, context) => ({
        assignment: await context.services.researchAssignments.escalate(
          args.input,
        ),
      }),
    }),
  }));
}
