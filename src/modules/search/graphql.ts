import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import { PageInfo, Sensitivity } from "@/modules/people/graphql";

import type { SavedQueryConnection, SavedQueryRow } from "./saved-query";
import { calculateSearchWorkCost, searchLexemes } from "./normalization";
import type { SearchConnection, SearchHit, SearchSnippetPart } from "./types";
import type { AnalysisResult } from "./analysis";
import type { ExportPreview } from "@/modules/exports/preview";
import type { ExportApprovalProjection } from "@/modules/exports/approval-service";
import type { exportArtifacts } from "@/db/schema/search";

function dateTimeInput(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}

function exclusiveMatch(input: {
  namespace?: string | null;
  protectedKind?: "PHONE" | "PERSON_IDENTIFIER" | null;
  query?: string | null;
  type: "text" | "protectedExact";
  value?: string | null;
}) {
  const valid =
    input.type === "text"
      ? typeof input.query === "string" &&
        input.protectedKind == null &&
        input.value == null &&
        input.namespace == null
      : input.query == null &&
        typeof input.value === "string" &&
        ((input.protectedKind === "PHONE" && input.namespace == null) ||
          (input.protectedKind === "PERSON_IDENTIFIER" &&
            typeof input.namespace === "string"));
  if (!valid)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      publicErrorMessage("VALIDATION_FAILED"),
    );
}

function graphQLSearchComplexity(input: {
  filters: Record<string, unknown>;
  first?: number | null;
  kinds: readonly unknown[];
  match: { query?: string | null };
}) {
  const terms =
    typeof input.match.query === "string"
      ? Math.max(
          1,
          searchLexemes(input.match.query).filter((term) => !term.operator)
            .length,
        )
      : 1;
  const filterLeaves = Object.values(input.filters).reduce<number>(
    (total, value) =>
      total + (Array.isArray(value) ? value.length : value ? 1 : 0),
    0,
  );
  return calculateSearchWorkCost({
    filterLeaves,
    first: input.first ?? 25,
    kinds: input.kinds.length,
    terms,
  }).complexity;
}

const SearchResultKind = builder.enumType("SearchResultKind", {
  values: ["PERSON", "FACT", "ADDRESS", "RELATIONSHIP", "EVIDENCE"] as const,
});
const SearchMatchType = builder.enumType("SearchMatchType", {
  values: {
    TEXT: { value: "text" },
    PROTECTED_EXACT: { value: "protectedExact" },
  } as const,
});
const ProtectedSearchKind = builder.enumType("ProtectedSearchKind", {
  values: ["PHONE", "PERSON_IDENTIFIER"] as const,
});
const SavedQuerySharing = builder.enumType("SavedQuerySharing", {
  values: ["PRIVATE", "WORKSPACE"] as const,
});
const ResearchAnalysisKind = builder.enumType("ResearchAnalysisKind", {
  values: [
    "TIMELINE",
    "SOURCE_COMPARISON",
    "DUPLICATE_CANDIDATES",
    "CONTRADICTIONS",
    "GRAPH_METRICS",
  ] as const,
});
const ResearchAnalysisInput = builder.inputType("ResearchAnalysisInput", {
  fields: (t) => ({
    kind: t.field({ type: ResearchAnalysisKind, required: true }),
    query: t.string({ required: true }),
    caseId: t.field({ type: "UUID" }),
    sensitivities: t.field({ type: [Sensitivity] }),
    from: t.field({ type: "DateTime" }),
    until: t.field({ type: "DateTime" }),
    reviewState: t.stringList(),
    relationshipState: t.stringList(),
    sourceReliabilityMin: t.float(),
    sourceReliabilityMax: t.float(),
    first: t.int(),
  }),
});
const ResearchAnalysisExplanation = builder
  .objectRef<AnalysisResult["explanation"]>("ResearchAnalysisExplanation")
  .implement({
    fields: (t) => ({
      sourceRows: t.exposeInt("sourceRows"),
      returnedRows: t.exposeInt("returnedRows"),
      timeWindow: t.field({
        type: "JSON",
        resolve: (value) => value.timeWindow,
      }),
      filters: t.field({ type: "JSON", resolve: (value) => value.filters }),
      omittedFields: t.stringList({
        resolve: (value) => [...value.omittedFields],
      }),
      methodology: t.exposeString("methodology"),
    }),
  });
const ResearchAnalysisResult = builder
  .objectRef<AnalysisResult>("ResearchAnalysisResult")
  .implement({
    fields: (t) => ({
      kind: t.field({
        type: ResearchAnalysisKind,
        resolve: (value) => value.kind,
      }),
      rows: t.field({ type: "JSON", resolve: (value) => value.rows }),
      appliedFilters: t.field({
        type: "JSON",
        resolve: (value) => value.appliedFilters,
      }),
      limit: t.exposeInt("limit"),
      redactedFieldCount: t.exposeInt("redactedFieldCount"),
      explanation: t.field({
        type: ResearchAnalysisExplanation,
        resolve: (value) => value.explanation,
      }),
    }),
  });
const ExportRedactionProfile = builder.enumType("ExportRedactionProfile", {
  values: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const,
});
const ExportApprovalState = builder.enumType("ExportApprovalState", {
  values: {
    REQUESTED: { value: "requested" },
    APPROVED: { value: "approved" },
    REJECTED: { value: "rejected" },
  } as const,
});
const ExportApprovalDecision = builder.enumType("ExportApprovalDecision", {
  values: {
    APPROVED: { value: "approved" },
    REJECTED: { value: "rejected" },
  } as const,
});
const PreviewExportInput = builder.inputType("PreviewExportInput", {
  fields: (t) => ({
    query: t.string({ required: true }),
    purpose: t.string({ required: true }),
    caseId: t.field({ type: "UUID" }),
    redactionProfile: t.field({ type: ExportRedactionProfile, required: true }),
    first: t.int(),
  }),
});
const ExportPreviewType = builder
  .objectRef<ExportPreview>("ExportPreview")
  .implement({
    fields: (t) => ({
      workspaceId: t.exposeString("workspaceId"),
      purpose: t.exposeString("purpose"),
      caseId: t.expose("caseId", { type: "UUID", nullable: true }),
      redactionProfile: t.field({
        type: ExportRedactionProfile,
        resolve: (value) => value.redactionProfile,
      }),
      rows: t.field({ type: "JSON", resolve: (value) => value.rows }),
      fieldCounts: t.field({
        type: "JSON",
        resolve: (value) => value.fieldCounts,
      }),
      approvalRequired: t.exposeBoolean("approvalRequired"),
      previewHash: t.exposeString("previewHash"),
      expiresAt: t.field({
        type: "DateTime",
        resolve: (value) => value.expiresAt,
      }),
      commitToken: t.exposeString("commitToken"),
      provenanceManifest: t.field({
        type: "JSON",
        resolve: (value) => value.provenanceManifest,
      }),
    }),
  });
const ExportApprovalType = builder
  .objectRef<ExportApprovalProjection>("ExportApproval")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      workspaceId: t.expose("workspaceId", { type: "UUID" }),
      caseId: t.expose("caseId", { type: "UUID", nullable: true }),
      purpose: t.exposeString("purpose"),
      previewHash: t.exposeString("previewHash"),
      redactionProfile: t.field({
        type: ExportRedactionProfile,
        resolve: (value) => value.redactionProfile,
      }),
      requestedByPrincipalId: t.expose("requestedByPrincipalId", {
        type: "UUID",
      }),
      reviewedByPrincipalId: t.expose("reviewedByPrincipalId", {
        type: "UUID",
        nullable: true,
      }),
      state: t.field({
        type: ExportApprovalState,
        resolve: (value) => value.state,
      }),
      requestReason: t.exposeString("requestReason"),
      decisionReason: t.exposeString("decisionReason", { nullable: true }),
      expiresAt: t.field({
        type: "DateTime",
        resolve: (value) => value.expiresAt.toISOString(),
      }),
      reviewedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (value) => value.reviewedAt?.toISOString() ?? null,
      }),
      requestAuditReference: t.expose("requestAuditReference", {
        type: "UUID",
      }),
      reviewAuditReference: t.expose("reviewAuditReference", {
        type: "UUID",
        nullable: true,
      }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (value) => value.createdAt.toISOString(),
      }),
    }),
  });
const RequestExportApprovalInput = builder.inputType(
  "RequestExportApprovalInput",
  {
    fields: (t) => ({
      purpose: t.string({ required: true }),
      caseId: t.field({ type: "UUID" }),
      previewHash: t.string({ required: true }),
      redactionProfile: t.field({
        type: ExportRedactionProfile,
        required: true,
      }),
      requestReason: t.string({ required: true }),
      expiresAt: t.field({ type: "DateTime", required: true }),
      idempotencyKey: t.string({ required: true }),
    }),
  },
);
const ReviewExportApprovalInput = builder.inputType(
  "ReviewExportApprovalInput",
  {
    fields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
      decision: t.field({ type: ExportApprovalDecision, required: true }),
      reason: t.string({ required: true }),
      idempotencyKey: t.string({ required: true }),
    }),
  },
);
type ExportArtifactRow = typeof exportArtifacts.$inferSelect;
const ExportArtifactType = builder
  .objectRef<ExportArtifactRow>("ExportArtifact")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      fileId: t.expose("fileId", { type: "UUID" }),
      caseId: t.expose("caseId", { type: "UUID", nullable: true }),
      purpose: t.exposeString("purpose"),
      redactionProfile: t.field({
        type: ExportRedactionProfile,
        resolve: (value) =>
          value.redactionProfile as
            "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED",
      }),
      format: t.exposeString("format"),
      state: t.exposeString("state"),
      rowCount: t.exposeInt("rowCount"),
      fieldCounts: t.field({
        type: "JSON",
        resolve: (value) => value.fieldCounts,
      }),
      expiresAt: t.field({
        type: "DateTime",
        resolve: (value) => value.expiresAt.toISOString(),
      }),
      createdAt: t.field({
        type: "DateTime",
        resolve: (value) => value.createdAt.toISOString(),
      }),
    }),
  });
const CommitExportInput = builder.inputType("CommitExportInput", {
  fields: (t) => ({
    query: t.string({ required: true }),
    purpose: t.string({ required: true }),
    caseId: t.field({ type: "UUID" }),
    redactionProfile: t.field({ type: ExportRedactionProfile, required: true }),
    first: t.int(),
    format: t.string({ required: true }),
    commitToken: t.string({ required: true }),
    idempotencyKey: t.string({ required: true }),
  }),
});

const SearchMatchInput = builder.inputType("SearchMatchInput", {
  fields: (t) => ({
    type: t.field({ type: SearchMatchType, required: true }),
    query: t.string(),
    protectedKind: t.field({ type: ProtectedSearchKind }),
    value: t.string(),
    namespace: t.string(),
  }),
});

const SearchFiltersInput = builder.inputType("SearchFiltersInput", {
  fields: (t) => ({
    personIds: t.field({ type: ["UUID"] }),
    factDefinitionIds: t.field({ type: ["UUID"] }),
    factStates: t.stringList(),
    relationshipTypeIds: t.field({ type: ["UUID"] }),
    relationshipStates: t.stringList(),
    sourceIds: t.field({ type: ["UUID"] }),
    sensitivities: t.field({ type: [Sensitivity] }),
    at: t.field({ type: "DateTime" }),
    from: t.field({ type: "DateTime" }),
    until: t.field({ type: "DateTime" }),
  }),
});

const SearchInput = builder.inputType("SearchInput", {
  fields: (t) => ({
    version: t.int({ required: true }),
    match: t.field({ type: SearchMatchInput, required: true }),
    kinds: t.field({ type: [SearchResultKind], required: true }),
    filters: t.field({ type: SearchFiltersInput, required: true }),
    first: t.int(),
    after: t.string(),
  }),
});

const SearchSnippetPartType = builder
  .objectRef<SearchSnippetPart>("SearchSnippetPart")
  .implement({
    fields: (t) => ({
      text: t.exposeString("text"),
      matched: t.exposeBoolean("matched"),
    }),
  });

const SearchHitType = builder.objectRef<SearchHit>("SearchHit").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    kind: t.field({ type: SearchResultKind, resolve: (hit) => hit.kind }),
    title: t.exposeString("title"),
    rank: t.exposeFloat("rank", { nullable: true }),
    updatedAt: t.field({ type: "DateTime", resolve: (hit) => hit.updatedAt }),
    subjectPersonId: t.expose("subjectPersonId", {
      type: "UUID",
      nullable: true,
    }),
    snippet: t.expose("snippet", {
      type: [SearchSnippetPartType],
      complexity: { field: 0, multiplier: 1 },
    }),
  }),
});

const SearchConnectionType = builder
  .objectRef<SearchConnection>("SearchConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [SearchHitType],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const SavedQueryType = builder
  .objectRef<SavedQueryRow>("SavedQuery")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      ownerPrincipalId: t.expose("ownerPrincipalId", { type: "UUID" }),
      name: t.exposeString("name"),
      sharing: t.field({
        type: SavedQuerySharing,
        resolve: (row) => row.sharing as "PRIVATE" | "WORKSPACE",
      }),
      queryAst: t.field({ type: "JSON", resolve: (row) => row.queryAst }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (row) => row.updatedAt.toISOString(),
      }),
      archivedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.archivedAt?.toISOString() ?? null,
      }),
    }),
  });

const SavedQueryConnectionType = builder
  .objectRef<SavedQueryConnection>("SavedQueryConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [SavedQueryType],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const CreateSavedQueryInput = builder.inputType("CreateSavedQueryInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    sharing: t.field({ type: SavedQuerySharing, required: true }),
    queryAst: t.field({ type: "JSON", required: true }),
  }),
});

const UpdateSavedQueryInput = builder.inputType("UpdateSavedQueryInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    name: t.string(),
    sharing: t.field({ type: SavedQuerySharing }),
    queryAst: t.field({ type: "JSON" }),
  }),
});

export function registerSearchGraphQL(): void {
  builder.queryFields((t) => ({
    researchAnalysis: t.field({
      type: ResearchAnalysisResult,
      args: { input: t.arg({ type: ResearchAnalysisInput, required: true }) },
      complexity: { field: 250, multiplier: 1 },
      resolve: (_root, args, context) => {
        requirePermission(context, "search", "read");
        return context.services.search.analyze({
          kind: args.input.kind,
          query: args.input.query,
          facets: {
            ...(args.input.caseId ? { caseId: args.input.caseId } : {}),
            ...(args.input.sensitivities?.length
              ? { sensitivity: args.input.sensitivities }
              : {}),
            ...(args.input.from || args.input.until
              ? {
                  temporalRange: {
                    from: dateTimeInput(args.input.from),
                    until: dateTimeInput(args.input.until),
                  },
                }
              : {}),
            ...(args.input.reviewState?.length
              ? { reviewState: args.input.reviewState }
              : {}),
            ...(args.input.relationshipState?.length
              ? { relationshipState: args.input.relationshipState }
              : {}),
            ...(args.input.sourceReliabilityMin != null ||
            args.input.sourceReliabilityMax != null
              ? {
                  sourceReliability: {
                    min: args.input.sourceReliabilityMin ?? undefined,
                    max: args.input.sourceReliabilityMax ?? undefined,
                  },
                }
              : {}),
          },
          first: args.input.first ?? undefined,
        });
      },
    }),
    search: t.field({
      type: SearchConnectionType,
      nullable: false,
      args: { input: t.arg({ type: SearchInput, required: true }) },
      complexity: (args) => ({
        field: graphQLSearchComplexity(args.input as never),
      }),
      resolve: (_root, args, context) => {
        requirePermission(context, "search", "read");
        exclusiveMatch(args.input.match);
        const match =
          args.input.match.type === "text"
            ? {
                type: "text" as const,
                query: args.input.match.query,
              }
            : {
                type: "protectedExact" as const,
                kind: args.input.match.protectedKind,
                value: args.input.match.value,
                namespace: args.input.match.namespace ?? undefined,
              };
        const filters = {
          ...args.input.filters,
          at: dateTimeInput(args.input.filters.at),
          from: dateTimeInput(args.input.filters.from),
          until: dateTimeInput(args.input.filters.until),
        };
        return context.services.search.search({
          version: args.input.version,
          match,
          kinds: args.input.kinds,
          filters,
          first: args.input.first ?? undefined,
          after: args.input.after ?? undefined,
        });
      },
    }),
    savedQueries: t.field({
      type: SavedQueryConnectionType,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 10,
        multiplier: Math.min(Math.max(args.first ?? 25, 1), 100),
      }),
      resolve: (_root, args, context) => {
        requirePermission(context, "savedQuery", "read");
        return context.services.search.list({
          first: args.first,
          after: args.after,
        });
      },
    }),
    savedQuery: t.field({
      type: SavedQueryType,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "savedQuery", "read");
        return context.services.search.read(args.id);
      },
    }),
  }));

  builder.mutationFields((t) => ({
    previewExport: t.field({
      type: ExportPreviewType,
      args: { input: t.arg({ type: PreviewExportInput, required: true }) },
      complexity: { field: 150, multiplier: 1 },
      resolve: (_root, args, context) => {
        requirePermission(context, "search", "read");
        return context.services.search.previewExport({
          ...args.input,
          first: args.input.first ?? undefined,
        });
      },
    }),
    requestExportApproval: t.field({
      type: ExportApprovalType,
      args: {
        input: t.arg({ type: RequestExportApprovalInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        requirePermission(context, "file", "create");
        requirePermission(context, "search", "read");
        return context.services.exportApprovals.request({
          ...args.input,
          caseId: args.input.caseId ?? null,
        });
      },
    }),
    reviewExportApproval: t.field({
      type: ExportApprovalType,
      args: {
        input: t.arg({ type: ReviewExportApprovalInput, required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "read");
        return context.services.exportApprovals.review(args.input);
      },
    }),
    commitExport: t.field({
      type: ExportArtifactType,
      args: { input: t.arg({ type: CommitExportInput, required: true }) },
      complexity: { field: 250, multiplier: 1 },
      resolve: (_root, args, context) => {
        requirePermission(context, "workspace", "update");
        requirePermission(context, "file", "create");
        requirePermission(context, "search", "read");
        if (args.input.format !== "JSON" && args.input.format !== "CSV") {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The export format is invalid.",
          );
        }
        return context.services.search.commitExport({
          ...args.input,
          format: args.input.format,
          first: args.input.first ?? undefined,
        });
      },
    }),
    createSavedQuery: t.field({
      type: SavedQueryType,
      args: { input: t.arg({ type: CreateSavedQueryInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "savedQuery", "create");
        return context.services.search.create({
          name: args.input.name,
          sharing: args.input.sharing,
          queryAst: args.input.queryAst,
        });
      },
    }),
    updateSavedQuery: t.field({
      type: SavedQueryType,
      args: { input: t.arg({ type: UpdateSavedQueryInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "savedQuery", "update");
        return context.services.search.update({
          id: args.input.id,
          expectedVersion: args.input.expectedVersion,
          name: args.input.name ?? undefined,
          sharing: args.input.sharing ?? undefined,
          queryAst: args.input.queryAst ?? undefined,
        });
      },
    }),
    archiveSavedQuery: t.field({
      type: SavedQueryType,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
      },
      resolve: (_root, args, context) => {
        requirePermission(context, "savedQuery", "delete");
        return context.services.search.archive(args);
      },
    }),
    runSavedQuery: t.field({
      type: SearchConnectionType,
      args: { id: t.arg({ type: "UUID", required: true }) },
      complexity: { field: 250, multiplier: 1 },
      resolve: (_root, args, context) => {
        requirePermission(context, "savedQuery", "read");
        requirePermission(context, "savedQuery", "run");
        requirePermission(context, "search", "run");
        return context.services.search.run(args.id);
      },
    }),
  }));
}
