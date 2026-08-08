import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { PageInfo, Sensitivity } from "@/modules/people/graphql";

import type { GraphMetric } from "./metrics";
import type { AnalysisRunRow, GraphSnapshotRow } from "./repository";
import {
  analysisExportComplexity,
  analysisResultReadComplexity,
  analysisRunListComplexity,
  analysisRunReadComplexity,
} from "./analysis-read-limits";
import type {
  AnalysisResultConnection as AnalysisResultConnectionShape,
  AnalysisRunConnection as AnalysisRunConnectionShape,
  GraphViewAppearance,
  GraphViewLayout,
  GraphViewConnection as GraphViewConnectionShape,
  GraphPositionConnection as GraphPositionConnectionShape,
  GraphViewRecord,
  GraphViewSummary,
} from "./service";
import type {
  GraphEdge,
  GraphLimits,
  GraphNode,
  GraphPosition,
  GraphResult,
  NormalizedGraphFilter,
} from "./types";

const GraphTraversalMode = builder.enumType("GraphTraversalMode", {
  values: ["WORKSPACE", "NEIGHBORHOOD"] as const,
});
const GraphAnalysisAlgorithm = builder.enumType("GraphAnalysisAlgorithm", {
  values: ["DEGREE", "PAGERANK", "LOUVAIN_COMMUNITY"] as const,
});
const GraphAnalysisExportFormat = builder.enumType(
  "GraphAnalysisExportFormat",
  {
    values: ["JSON", "CSV"] as const,
  },
);
const GraphLayoutAlgorithm = builder.enumType("GraphLayoutAlgorithm", {
  values: ["CIRCLE", "FORCE_ATLAS_2"] as const,
});
const GraphPalette = builder.enumType("GraphPalette", {
  values: ["DEFAULT", "MONOCHROME"] as const,
});
const GraphViewSharing = builder.enumType("GraphViewSharing", {
  values: { PRIVATE: { value: "private" }, WORKSPACE: { value: "workspace" } },
});
const GraphRelationshipState = builder.enumType("GraphRelationshipState", {
  values: {
    ASSERTED: { value: "asserted" },
    INFERRED: { value: "inferred" },
    CORROBORATED: { value: "corroborated" },
    DISPUTED: { value: "disputed" },
    DISPROVEN: { value: "disproven" },
    INACTIVE: { value: "inactive" },
  } as const,
});

export const GraphFilterInput = builder.inputType("GraphFilterInput", {
  fields: (t) => ({
    mode: t.field({ type: GraphTraversalMode, required: true }),
    rootPersonIds: t.field({ type: ["UUID"] }),
    depth: t.int(),
    relationshipTypeIds: t.field({ type: ["UUID"] }),
    relationshipStates: t.field({ type: [GraphRelationshipState] }),
    sensitivities: t.field({ type: [Sensitivity] }),
    minimumConfidence: t.float(),
    at: t.field({ type: "DateTime" }),
    from: t.field({ type: "DateTime" }),
    until: t.field({ type: "DateTime" }),
    nodeLimit: t.int(),
    edgeLimit: t.int(),
    includeIsolates: t.boolean(),
  }),
});

const GraphNodeType = builder.objectRef<GraphNode>("GraphNode").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    displayName: t.exposeString("displayName"),
    sortName: t.exposeString("sortName", { nullable: true }),
    status: t.exposeString("status"),
    sensitivity: t.field({
      type: Sensitivity,
      resolve: (node) => node.sensitivity,
    }),
    version: t.exposeInt("version"),
  }),
});

const GraphEdgeType = builder.objectRef<GraphEdge>("GraphEdge").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    relationshipId: t.expose("relationshipId", { type: "UUID" }),
    source: t.expose("source", { type: "UUID" }),
    target: t.expose("target", { type: "UUID" }),
    relationshipTypeId: t.expose("relationshipTypeId", { type: "UUID" }),
    forwardLabel: t.exposeString("forwardLabel"),
    inverseLabel: t.exposeString("inverseLabel"),
    directed: t.exposeBoolean("directed"),
    state: t.field({
      type: GraphRelationshipState,
      resolve: (edge) => edge.state,
    }),
    sensitivity: t.field({
      type: Sensitivity,
      resolve: (edge) => edge.sensitivity,
    }),
    confidence: t.exposeFloat("confidence"),
    strength: t.exposeFloat("strength", { nullable: true }),
    temporalSemantics: t.exposeString("temporalSemantics"),
    temporalPrecision: t.exposeString("temporalPrecision"),
    validFrom: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (edge) => edge.validFrom,
    }),
    validUntil: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (edge) => edge.validUntil,
    }),
    version: t.exposeInt("version"),
  }),
});

const NormalizedGraphFilterType = builder
  .objectRef<NormalizedGraphFilter>("NormalizedGraphFilter")
  .implement({
    fields: (t) => ({
      mode: t.field({
        type: GraphTraversalMode,
        resolve: (filter) => filter.mode,
      }),
      rootPersonIds: t.field({
        type: ["UUID"],
        resolve: (filter) => filter.rootPersonIds,
      }),
      depth: t.exposeInt("depth"),
      relationshipTypeIds: t.field({
        type: ["UUID"],
        resolve: (filter) => filter.relationshipTypeIds,
      }),
      relationshipStates: t.field({
        type: [GraphRelationshipState],
        resolve: (filter) => filter.relationshipStates,
      }),
      sensitivities: t.field({
        type: [Sensitivity],
        resolve: (filter) => filter.sensitivities,
      }),
      minimumConfidence: t.exposeFloat("minimumConfidence", { nullable: true }),
      at: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (filter) => filter.at,
      }),
      from: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (filter) => filter.from,
      }),
      until: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (filter) => filter.until,
      }),
      nodeLimit: t.exposeInt("nodeLimit"),
      edgeLimit: t.exposeInt("edgeLimit"),
      includeIsolates: t.exposeBoolean("includeIsolates"),
    }),
  });

const GraphLimitsType = builder
  .objectRef<GraphLimits>("GraphLimits")
  .implement({
    fields: (t) => ({
      requestedNodeLimit: t.exposeInt("requestedNodeLimit"),
      requestedEdgeLimit: t.exposeInt("requestedEdgeLimit"),
      returnedNodeCount: t.exposeInt("returnedNodeCount"),
      returnedEdgeCount: t.exposeInt("returnedEdgeCount"),
      nodesTruncated: t.exposeBoolean("nodesTruncated"),
      edgesTruncated: t.exposeBoolean("edgesTruncated"),
      reasons: t.exposeStringList("reasons"),
    }),
  });

export const GraphResultType = builder
  .objectRef<GraphResult>("GraphResult")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [GraphNodeType],
        complexity: { field: 0, multiplier: 1 },
      }),
      edges: t.expose("edges", {
        type: [GraphEdgeType],
        complexity: { field: 0, multiplier: 1 },
      }),
      normalizedFilter: t.expose("normalizedFilter", {
        type: NormalizedGraphFilterType,
      }),
      limits: t.expose("limits", { type: GraphLimitsType }),
      fingerprint: t.exposeString("fingerprint"),
      generatedAt: t.field({
        type: "DateTime",
        resolve: (result) => result.generatedAt,
      }),
    }),
  });

const GraphPositionType = builder
  .objectRef<GraphPosition>("GraphPosition")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      x: t.exposeFloat("x"),
      y: t.exposeFloat("y"),
    }),
  });
const GraphPositionConnection = builder
  .objectRef<GraphPositionConnectionShape>("GraphPositionConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [GraphPositionType],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });
const GraphViewLayoutSettingsType = builder
  .objectRef<GraphViewLayout["settings"]>("GraphViewLayoutSettings")
  .implement({
    fields: (t) => ({
      barnesHutOptimize: t.exposeBoolean("barnesHutOptimize"),
      gravity: t.exposeFloat("gravity"),
      scalingRatio: t.exposeFloat("scalingRatio"),
      slowDown: t.exposeFloat("slowDown"),
    }),
  });
const GraphViewLayoutType = builder
  .objectRef<GraphViewLayout>("GraphViewLayout")
  .implement({
    fields: (t) => ({
      version: t.exposeString("version"),
      algorithm: t.field({
        type: GraphLayoutAlgorithm,
        resolve: (layout) => layout.algorithm,
      }),
      settings: t.expose("settings", { type: GraphViewLayoutSettingsType }),
    }),
  });
const GraphViewAppearanceType = builder
  .objectRef<GraphViewAppearance>("GraphViewAppearance")
  .implement({
    fields: (t) => ({
      version: t.exposeString("version"),
      palette: t.field({
        type: GraphPalette,
        resolve: (appearance) => appearance.palette,
      }),
      showLabels: t.exposeBoolean("showLabels"),
    }),
  });

const GraphViewType = builder
  .objectRef<GraphViewRecord>("GraphView")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      name: t.exposeString("name"),
      filter: t.expose("filter", { type: NormalizedGraphFilterType }),
      layout: t.expose("layoutValue", { type: GraphViewLayoutType }),
      appearance: t.expose("appearanceValue", {
        type: GraphViewAppearanceType,
      }),
      sharing: t.field({
        type: GraphViewSharing,
        resolve: (view) => view.sharing as "private" | "workspace",
      }),
      positions: t.field({
        type: GraphPositionConnection,
        nullable: false,
        args: { first: t.arg.int(), after: t.arg.string() },
        complexity: (args) => ({
          field: positionFieldCost(args.first),
        }),
        resolve: (view, args, context) => {
          requireGraphRead(context);
          requirePermission(context, "graphView", "read");
          return context.services.graph.listViewPositions(view.id, args);
        },
      }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (view) => view.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (view) => view.updatedAt.toISOString(),
      }),
    }),
  });

const GraphViewSummaryType = builder
  .objectRef<GraphViewSummary>("GraphViewSummary")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      name: t.exposeString("name"),
      filter: t.expose("filter", { type: NormalizedGraphFilterType }),
      layout: t.expose("layoutValue", { type: GraphViewLayoutType }),
      appearance: t.expose("appearanceValue", {
        type: GraphViewAppearanceType,
      }),
      sharing: t.field({
        type: GraphViewSharing,
        resolve: (view) => view.sharing as "private" | "workspace",
      }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (view) => view.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (view) => view.updatedAt.toISOString(),
      }),
    }),
  });

const GraphViewConnection = builder
  .objectRef<GraphViewConnectionShape>("GraphViewConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [GraphViewSummaryType],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });

const GraphMetricType = builder
  .objectRef<GraphMetric>("GraphMetric")
  .implement({
    fields: (t) => ({
      personId: t.expose("personId", { type: "UUID" }),
      metricKey: t.exposeString("metricKey"),
      value: t.exposeFloat("value"),
      rank: t.exposeInt("rank"),
      algorithmVersion: t.exposeString("algorithmVersion"),
      explanation: t.exposeString("explanation"),
    }),
  });
const GraphAnalysisRunType = builder
  .objectRef<AnalysisRunRow>("GraphAnalysisRun")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      algorithm: t.exposeString("algorithm"),
      graphSnapshotId: t.expose("graphSnapshotId", { type: "UUID" }),
      state: t.exposeString("state"),
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
      createdAt: t.field({
        type: "DateTime",
        resolve: (run) => run.createdAt.toISOString(),
      }),
    }),
  });
const GraphSnapshotType = builder
  .objectRef<GraphSnapshotRow>("GraphSnapshot")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      manifestSchema: t.exposeString("manifestSchema"),
      manifestHash: t.exposeString("manifestHash"),
      algorithm: t.exposeString("algorithm"),
      algorithmVersion: t.exposeString("algorithmVersion"),
      algorithmConfigHash: t.exposeString("algorithmConfigHash"),
      generatedAt: t.field({
        type: "DateTime",
        resolve: (snapshot) => snapshot.generatedAt.toISOString(),
      }),
    }),
  });
const GraphSnapshotReplayPayload = builder
  .objectRef<{ snapshot: GraphSnapshotRow | null; valid: boolean }>(
    "GraphSnapshotReplayPayload",
  )
  .implement({
    fields: (t) => ({
      snapshot: t.expose("snapshot", {
        type: GraphSnapshotType,
        nullable: true,
      }),
      valid: t.exposeBoolean("valid"),
    }),
  });
const GraphAnalysisRunConnection = builder
  .objectRef<AnalysisRunConnectionShape>("GraphAnalysisRunConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [GraphAnalysisRunType],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });
const GraphStatistics = builder
  .objectRef<{ visiblePeople: number; visibleRelationships: number }>(
    "GraphStatistics",
  )
  .implement({
    fields: (t) => ({
      visiblePeople: t.exposeInt("visiblePeople", { nullable: false }),
      visibleRelationships: t.exposeInt("visibleRelationships", {
        nullable: false,
      }),
    }),
  });
type GraphAnalysisResultRecord = {
  id: string;
  analysisRunId: string;
  resultKind: string;
  subjectPersonId: string | null;
  numericValue: string | null;
  rank: number | null;
  explanation: string | null;
  createdAt: Date;
};
const GraphAnalysisResultType = builder
  .objectRef<GraphAnalysisResultRecord>("GraphAnalysisResult")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      analysisRunId: t.expose("analysisRunId", { type: "UUID" }),
      resultKind: t.exposeString("resultKind"),
      subjectPersonId: t.expose("subjectPersonId", {
        type: "UUID",
        nullable: true,
      }),
      value: t.float({ resolve: (result) => Number(result.numericValue) }),
      rank: t.exposeInt("rank", { nullable: true }),
      explanation: t.exposeString("explanation", { nullable: true }),
      createdAt: t.field({
        type: "DateTime",
        resolve: (result) => result.createdAt.toISOString(),
      }),
    }),
  });
const GraphAnalysisResultConnection = builder
  .objectRef<AnalysisResultConnectionShape>("GraphAnalysisResultConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [GraphAnalysisResultType],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });
const GraphAnalysisPayload = builder
  .objectRef<{
    run: AnalysisRunRow;
    metrics: GraphMetric[];
    graph: GraphResult;
  }>("GraphAnalysisPayload")
  .implement({
    fields: (t) => ({
      run: t.expose("run", { type: GraphAnalysisRunType }),
      metrics: t.expose("metrics", {
        type: [GraphMetricType],
        complexity: { field: 0, multiplier: 1 },
      }),
      graph: t.expose("graph", { type: GraphResultType }),
    }),
  });
const GraphAnalysisExportType = builder
  .objectRef<{
    content: string;
    contentType: string;
    filename: string;
    format: "JSON" | "CSV";
    resultCount: number;
    truncated: boolean;
  }>("GraphAnalysisExport")
  .implement({
    fields: (t) => ({
      content: t.exposeString("content"),
      contentType: t.exposeString("contentType"),
      filename: t.exposeString("filename"),
      format: t.field({
        type: GraphAnalysisExportFormat,
        resolve: (value) => value.format,
      }),
      resultCount: t.exposeInt("resultCount"),
      truncated: t.exposeBoolean("truncated"),
    }),
  });

const GraphPositionInput = builder.inputType("GraphPositionInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    x: t.float({ required: true }),
    y: t.float({ required: true }),
  }),
});
const GraphViewLayoutSettingsInput = builder.inputType(
  "GraphViewLayoutSettingsInput",
  {
    fields: (t) => ({
      barnesHutOptimize: t.boolean(),
      gravity: t.float(),
      scalingRatio: t.float(),
      slowDown: t.float(),
    }),
  },
);
const GraphViewLayoutInput = builder.inputType("GraphViewLayoutInput", {
  fields: (t) => ({
    algorithm: t.field({ type: GraphLayoutAlgorithm }),
    settings: t.field({ type: GraphViewLayoutSettingsInput }),
  }),
});
const GraphViewAppearanceInput = builder.inputType("GraphViewAppearanceInput", {
  fields: (t) => ({
    palette: t.field({ type: GraphPalette }),
    showLabels: t.boolean(),
  }),
});
const CreateGraphViewInput = builder.inputType("CreateGraphViewInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    filter: t.field({ type: GraphFilterInput, required: true }),
    layout: t.field({ type: GraphViewLayoutInput }),
    appearance: t.field({ type: GraphViewAppearanceInput }),
    sharing: t.field({ type: GraphViewSharing }),
    positions: t.field({ type: [GraphPositionInput] }),
    idempotencyKey: t.string(),
  }),
});
const UpdateGraphViewInput = builder.inputType("UpdateGraphViewInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    name: t.string(),
    filter: t.field({ type: GraphFilterInput }),
    layout: t.field({ type: GraphViewLayoutInput }),
    appearance: t.field({ type: GraphViewAppearanceInput }),
    sharing: t.field({ type: GraphViewSharing }),
    positions: t.field({ type: [GraphPositionInput] }),
    idempotencyKey: t.string(),
  }),
});
const ArchiveGraphViewInput = builder.inputType("ArchiveGraphViewInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    idempotencyKey: t.string(),
  }),
});
const RunGraphAnalysisInput = builder.inputType("RunGraphAnalysisInput", {
  fields: (t) => ({
    filter: t.field({ type: GraphFilterInput }),
    algorithm: t.field({ type: GraphAnalysisAlgorithm, required: true }),
    graphViewId: t.field({ type: "UUID" }),
  }),
});
const RerunGraphAnalysisInput = builder.inputType("RerunGraphAnalysisInput", {
  fields: (t) => ({
    snapshotId: t.field({ type: "UUID", required: true }),
    algorithm: t.field({ type: GraphAnalysisAlgorithm, required: true }),
  }),
});
const ReplayGraphSnapshotInput = builder.inputType("ReplayGraphSnapshotInput", {
  fields: (t) => ({
    snapshotId: t.field({ type: "UUID", required: true }),
  }),
});

function graphFieldCost(
  input:
    { nodeLimit?: number | null; edgeLimit?: number | null } | null | undefined,
) {
  if (!input) return 400;
  const bounded = (
    value: number | null | undefined,
    fallback: number,
    maximum: number,
  ) =>
    Number.isInteger(value)
      ? Math.min(Math.max(value ?? fallback, 0), maximum)
      : maximum;
  return (
    250 +
    Math.ceil(bounded(input?.nodeLimit, 1_000, 10_000) / 100) +
    Math.ceil(bounded(input?.edgeLimit, 4_000, 25_000) / 500)
  );
}

function positionFieldCost(value: number | null | undefined) {
  const limit =
    value == null
      ? 25
      : Number.isInteger(value) && value >= 1 && value <= 250
        ? value!
        : 250;
  return 25 + Math.ceil(limit / 25);
}

function pageMultiplier(first: number | null | undefined) {
  return first == null
    ? 25
    : Number.isInteger(first) && first >= 1 && first <= 100
      ? first
      : 101;
}

function requireGraphRead(context: Parameters<typeof requirePermission>[0]) {
  requirePermission(context, "graph", "read");
  requirePermission(context, "person", "read");
  requirePermission(context, "relationship", "read");
}

export function registerGraphGraphQL(): void {
  builder.queryFields((t) => ({
    graph: t.field({
      type: GraphResultType,
      args: { filter: t.arg({ type: GraphFilterInput, required: true }) },
      complexity: (args) => ({ field: graphFieldCost(args.filter) }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        return context.services.graph.query(args.filter);
      },
    }),
    graphViews: t.field({
      type: GraphViewConnection,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graphView", "read");
        return context.services.graph.listViews(args);
      },
    }),
    graphView: t.field({
      type: GraphViewType,
      nullable: true,
      args: {
        id: t.arg({ type: "UUID", required: true }),
      },
      complexity: { field: 10 },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graphView", "read");
        return context.services.graph.getView(args.id);
      },
    }),
    graphAnalysisRun: t.field({
      type: GraphAnalysisRunType,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      complexity: { field: analysisRunReadComplexity() },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "analysis", "read");
        return context.services.graph.getAnalysisRun(args.id);
      },
    }),
    graphAnalysisRuns: t.field({
      type: GraphAnalysisRunConnection,
      nullable: false,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: analysisRunListComplexity(args.first) }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "analysis", "read");
        return context.services.graph.listAnalysisRuns(args);
      },
    }),
    dashboardRecentGraphAnalyses: t.field({
      type: GraphAnalysisRunConnection,
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
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "analysis", "read");
        return context.services.graph.listRecentAnalysisRuns(args);
      },
    }),
    graphStatistics: t.field({
      type: GraphStatistics,
      nullable: false,
      complexity: { field: 6, multiplier: 1 },
      resolve: (_root, _args, context) => {
        requireGraphRead(context);
        return context.services.graph.statistics();
      },
    }),
    graphAnalysisResults: t.field({
      type: GraphAnalysisResultConnection,
      nullable: false,
      args: {
        runId: t.arg({ type: "UUID", required: true }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => ({
        field: analysisResultReadComplexity(args.first),
      }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "analysis", "read");
        return context.services.graph.getAnalysisResults(args);
      },
    }),
    graphSnapshot: t.field({
      type: GraphSnapshotType,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      complexity: { field: 400 },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "analysis", "read");
        return context.services.graph.getSnapshot(args.id);
      },
    }),
    graphAnalysisExport: t.field({
      type: GraphAnalysisExportType,
      args: {
        format: t.arg({ type: GraphAnalysisExportFormat, required: true }),
        first: t.arg.int(),
        runId: t.arg({ type: "UUID", required: true }),
      },
      complexity: (args) => ({
        field: analysisExportComplexity(args.first),
      }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "analysis", "read");
        return context.services.graph.exportAnalysisResults(args);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    createGraphView: t.field({
      type: GraphViewType,
      args: { input: t.arg({ type: CreateGraphViewInput, required: true }) },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graphView", "create");
        return context.services.graph.createView(args.input);
      },
    }),
    updateGraphView: t.field({
      type: GraphViewType,
      args: { input: t.arg({ type: UpdateGraphViewInput, required: true }) },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graphView", "update");
        return context.services.graph.updateView(args.input);
      },
    }),
    archiveGraphView: t.field({
      type: GraphViewType,
      args: { input: t.arg({ type: ArchiveGraphViewInput, required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "graphView", "delete");
        return context.services.graph.archiveView(args.input);
      },
    }),
    runGraphAnalysis: t.field({
      type: GraphAnalysisPayload,
      args: { input: t.arg({ type: RunGraphAnalysisInput, required: true }) },
      complexity: (args) => ({ field: graphFieldCost(args.input.filter) }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graph", "run");
        requirePermission(context, "analysis", "create");
        requirePermission(context, "analysis", "run");
        return context.services.graph.runAnalysis(args.input);
      },
    }),
    createGraphSnapshot: t.field({
      type: GraphSnapshotType,
      args: { input: t.arg({ type: RunGraphAnalysisInput, required: true }) },
      complexity: (args) => ({ field: graphFieldCost(args.input.filter) }),
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graph", "run");
        requirePermission(context, "analysis", "create");
        requirePermission(context, "analysis", "run");
        return context.services.graph.createSnapshot(args.input);
      },
    }),
    replayGraphSnapshot: t.field({
      type: GraphSnapshotReplayPayload,
      args: {
        input: t.arg({ type: ReplayGraphSnapshotInput, required: true }),
      },
      complexity: { field: 400 },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graph", "run");
        requirePermission(context, "analysis", "run");
        return context.services.graph.replaySnapshot(args.input.snapshotId);
      },
    }),
    rerunGraphAnalysis: t.field({
      type: GraphAnalysisPayload,
      args: { input: t.arg({ type: RerunGraphAnalysisInput, required: true }) },
      complexity: { field: 400 },
      resolve: (_root, args, context) => {
        requireGraphRead(context);
        requirePermission(context, "graph", "run");
        requirePermission(context, "analysis", "create");
        requirePermission(context, "analysis", "run");
        return context.services.graph.rerunAnalysis(args.input);
      },
    }),
  }));
}
