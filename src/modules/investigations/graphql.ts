import { builder } from "@/graphql/builder";
import { normalizePagination } from "@/graphql/limits";
import type { InvestigationCaseLinkRow, InvestigationRow } from "./types";

const Investigation = builder
  .objectRef<InvestigationRow>("Investigation")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      number: t.exposeInt("number"),
      slug: t.exposeString("slug"),
      title: t.exposeString("title"),
      objective: t.exposeString("objective"),
      purpose: t.exposeString("purpose"),
      sensitivity: t.exposeString("sensitivity"),
      state: t.exposeString("state"),
      leadPrincipalId: t.expose("leadPrincipalId", { type: "UUID" }),
      startedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (r) => r.startedAt?.toISOString() ?? null,
      }),
      endedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (r) => r.endedAt?.toISOString() ?? null,
      }),
      closedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (r) => r.closedAt?.toISOString() ?? null,
      }),
      closureReason: t.exposeString("closureReason", { nullable: true }),
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

const InvestigationCaseLink = builder
  .objectRef<InvestigationCaseLinkRow>("InvestigationCaseLink")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      investigationId: t.expose("investigationId", { type: "UUID" }),
      caseId: t.expose("caseId", { type: "UUID" }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (r) => r.createdAt.toISOString(),
      }),
    }),
  });

const PageInfo = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>(
    "InvestigationPageInfo",
  )
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });

const InvestigationConnection = builder
  .objectRef<{
    nodes: InvestigationRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("InvestigationConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [Investigation], resolve: (r) => r.nodes }),
      pageInfo: t.field({ type: PageInfo, resolve: (r) => r.pageInfo }),
    }),
  });

const InvestigationCaseLinkConnection = builder
  .objectRef<{ nodes: InvestigationCaseLinkRow[] }>(
    "InvestigationCaseLinkConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.field({
        type: [InvestigationCaseLink],
        resolve: (r) => r.nodes,
      }),
    }),
  });

export function registerInvestigationsGraphQL(): void {
  builder.queryFields((t) => ({
    investigation: t.field({
      type: Investigation,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) =>
        context.services.investigations.getInvestigation(args.id),
    }),
    investigations: t.field({
      type: InvestigationConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 1,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) =>
        context.services.investigations.listInvestigations(args),
    }),
    investigationCases: t.field({
      type: InvestigationCaseLinkConnection,
      args: { investigationId: t.arg({ type: "UUID", required: true }) },
      resolve: async (_root, args, context) => ({
        nodes: await context.services.investigations.listCaseLinks(args),
      }),
    }),
  }));

  builder.mutationFields((t) => ({
    createInvestigation: t.field({
      type: Investigation,
      args: {
        slug: t.arg.string(),
        title: t.arg.string({ required: true }),
        objective: t.arg.string({ required: true }),
        purpose: t.arg.string({ required: true }),
        sensitivity: t.arg.string(),
        state: t.arg.string(),
        leadPrincipalId: t.arg({ type: "UUID" }),
        startedAt: t.arg({ type: "DateTime" }),
        endedAt: t.arg({ type: "DateTime" }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) =>
        context.services.investigations.createInvestigation(args),
    }),
    linkCaseToInvestigation: t.field({
      type: InvestigationCaseLink,
      args: {
        investigationId: t.arg({ type: "UUID", required: true }),
        caseId: t.arg({ type: "UUID", required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) =>
        context.services.investigations.linkCase(args),
    }),
  }));
}
