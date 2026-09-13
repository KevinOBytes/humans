import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { normalizePagination } from "@/graphql/limits";

import type { BreakGlassService } from "./break-glass-service";
import { breakGlassResourceKinds } from "./break-glass-validation";

const BreakGlassState = builder.enumType("BreakGlassState", {
  values: {
    REQUESTED: { value: "requested" },
    APPROVED: { value: "approved" },
    REJECTED: { value: "rejected" },
    REVOKED: { value: "revoked" },
  } as const,
});

const BreakGlassResourceKind = builder.enumType("BreakGlassResourceKind", {
  values: Object.fromEntries(
    breakGlassResourceKinds.map((kind) => [
      kind.toUpperCase(),
      { value: kind },
    ]),
  ) as Record<
    Uppercase<(typeof breakGlassResourceKinds)[number]>,
    { value: string }
  >,
});

const BreakGlassResourceInput = builder.inputType("BreakGlassResourceInput", {
  fields: (t) => ({
    resourceKind: t.field({ type: BreakGlassResourceKind, required: true }),
    resourceId: t.field({ type: "UUID", required: true }),
  }),
});

type BreakGlassResource = {
  resourceKind: string;
  resourceId: string;
};
type BreakGlassRequest = Awaited<ReturnType<BreakGlassService["get"]>>;

const Resource = builder
  .objectRef<BreakGlassResource>("BreakGlassResource")
  .implement({
    fields: (t) => ({
      resourceKind: t.exposeString("resourceKind"),
      resourceId: t.expose("resourceId", { type: "UUID" }),
    }),
  });

const Request = builder
  .objectRef<BreakGlassRequest>("BreakGlassAccessRequest")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      purpose: t.exposeString("purpose"),
      justification: t.exposeString("justification"),
      caseReference: t.exposeString("caseReference", { nullable: true }),
      state: t.field({ type: BreakGlassState, resolve: (row) => row.state }),
      requesterPrincipalId: t.expose("requesterPrincipalId", { type: "UUID" }),
      reviewerPrincipalId: t.expose("reviewerPrincipalId", {
        type: "UUID",
        nullable: true,
      }),
      expiresAt: t.field({
        type: "DateTime",
        resolve: (row) => row.expiresAt.toISOString(),
      }),
      reviewedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.reviewedAt?.toISOString() ?? null,
      }),
      reviewReason: t.exposeString("reviewReason", { nullable: true }),
      revokedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.revokedAt?.toISOString() ?? null,
      }),
      resources: t.field({
        type: [Resource],
        resolve: (row) => row.resources,
      }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
    }),
  });

const PageInfo = builder
  .objectRef<{
    hasNextPage: boolean;
    endCursor: string | null;
  }>("BreakGlassPageInfo")
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });

const Connection = builder
  .objectRef<{
    nodes: BreakGlassRequest[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("BreakGlassAccessRequestConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", { type: [Request] }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

export function registerBreakGlassGraphQL(): void {
  builder.queryFields((t) => ({
    breakGlassAccessRequests: t.field({
      type: Connection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) => {
        requirePermission(context, "breakGlass", "read");
        return context.services.breakGlass.list(args);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    requestBreakGlassAccess: t.field({
      type: Request,
      args: {
        purpose: t.arg.string({ required: true }),
        justification: t.arg.string({ required: true }),
        expiresAt: t.arg({ type: "DateTime", required: true }),
        caseReference: t.arg.string(),
        resources: t.arg({ type: [BreakGlassResourceInput], required: true }),
        idempotencyKey: t.arg.string({ required: true }),
      },
      resolve: (_root, args, context) =>
        context.services.breakGlass.request(args) as never,
    }),
    reviewBreakGlassAccess: t.field({
      type: Request,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        state: t.arg({ type: BreakGlassState, required: true }),
        reason: t.arg.string({ required: true }),
        idempotencyKey: t.arg.string({ required: true }),
      },
      resolve: (_root, args, context) => {
        const state = args.state;
        if (state !== "approved" && state !== "rejected") {
          throw new Error("The break-glass review state is invalid.");
        }
        return context.services.breakGlass.review({ ...args, state }) as never;
      },
    }),
    revokeBreakGlassAccess: t.field({
      type: Request,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        reason: t.arg.string({ required: true }),
        idempotencyKey: t.arg.string({ required: true }),
      },
      resolve: (_root, args, context) =>
        context.services.breakGlass.revoke(args) as never,
    }),
  }));
}
