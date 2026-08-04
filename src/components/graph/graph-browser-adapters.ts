"use client";

import { executeBrowserGraphQL } from "@/graphql/client";
import {
  ArchiveGraphViewDocument,
  CreateGraphSnapshotDocument,
  CreateGraphViewDocument,
  GraphAnalysisRunsDocument,
  GraphAnalysisResultsDocument,
  GraphAnalysisExportDocument,
  GraphPageDocument,
  GraphSavedViewPageDocument,
  GraphWorkspaceControlsDocument,
  RerunGraphAnalysisDocument,
  ReplayGraphSnapshotDocument,
  RunGraphAnalysisDocument,
  UpdateGraphViewDocument,
  type GraphAnalysisRunsQuery,
  type GraphViewSharing,
  type RerunGraphAnalysisMutation,
  type RunGraphAnalysisMutation,
} from "@/graphql/generated/graphql";

import type {
  GraphAnalysisAdapter,
  GraphAnalysisMetric,
  GraphAnalysisPayload,
  GraphAnalysisResultItem,
  GraphAnalysisRunSummary,
  GraphSnapshotSummary,
} from "./graph-analysis";
import {
  graphPageResult,
  savedViewGraphFilter,
  savedViewPositions,
} from "./graph-page-model";
import type {
  GraphSavedViewAdapter,
  GraphSavedViewListPage,
  GraphSavedViewPageInfo,
  GraphSavedViewSummary,
} from "./graph-saved-views";

// This operation also selects reusable view configuration; ten rows remains
// below the server's 500-point GraphQL complexity ceiling.
const VIEW_PAGE_SIZE = 10;
const ANALYSIS_RUN_PAGE_SIZE = 10;
const ANALYSIS_RESULT_PAGE_SIZE = 100;
const POSITION_PAGE_SIZE = 250;

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new Error(`The graph response omitted ${field}.`);
  }
  return value;
}

function failure(errors: readonly { message: string }[]): Error {
  return new Error(
    errors[0]?.message ?? "The graph request could not be completed.",
  );
}

function mapViewSummary(
  view: {
    id: string | null;
    name: string | null;
    sharing: GraphViewSharing | null;
    updatedAt?: string | null;
    version: number | null;
  },
  field = "graphView",
): GraphSavedViewSummary {
  return {
    id: required(view.id, `${field}.id`),
    name: required(view.name, `${field}.name`),
    sharing: required(view.sharing, `${field}.sharing`),
    updatedAt: view.updatedAt ?? null,
    version: required(view.version, `${field}.version`),
  };
}

type WorkspaceRun = NonNullable<
  GraphAnalysisRunsQuery["graphAnalysisRuns"]["nodes"][number]
>;

function mapRun(
  run: WorkspaceRun,
  field = "graphAnalysisRun",
): GraphAnalysisRunSummary {
  return {
    algorithm: required(run.algorithm, `${field}.algorithm`),
    completedAt: run.completedAt ?? null,
    createdAt: required(run.createdAt, `${field}.createdAt`),
    graphSnapshotId: required(run.graphSnapshotId, `${field}.graphSnapshotId`),
    id: required(run.id, `${field}.id`),
    startedAt: run.startedAt ?? null,
    state: required(run.state, `${field}.state`),
  };
}

function mapSnapshot(
  snapshot: {
    algorithm: string | null;
    generatedAt: string | null;
    id: string | null;
    manifestHash: string | null;
  },
  field = "graphSnapshot",
): GraphSnapshotSummary {
  return {
    algorithm: required(snapshot.algorithm, `${field}.algorithm`),
    generatedAt: required(snapshot.generatedAt, `${field}.generatedAt`),
    id: required(snapshot.id, `${field}.id`),
    manifestHash: required(snapshot.manifestHash, `${field}.manifestHash`),
  };
}

type AnalysisMutationPayload = NonNullable<
  | RunGraphAnalysisMutation["runGraphAnalysis"]
  | RerunGraphAnalysisMutation["rerunGraphAnalysis"]
>;

function mapAnalysisPayload(
  payload: AnalysisMutationPayload | null,
): GraphAnalysisPayload | null {
  if (!payload) return null;
  const run = required(payload.run, "graphAnalysis.run");
  const graph = required(payload.graph, "graphAnalysis.graph");
  const metrics = required(payload.metrics, "graphAnalysis.metrics").map(
    (metric, index): GraphAnalysisMetric => ({
      algorithmVersion: required(
        metric.algorithmVersion,
        `graphAnalysis.metrics.${index}.algorithmVersion`,
      ),
      explanation: required(
        metric.explanation,
        `graphAnalysis.metrics.${index}.explanation`,
      ),
      metricKey: required(
        metric.metricKey,
        `graphAnalysis.metrics.${index}.metricKey`,
      ),
      personId: required(
        metric.personId,
        `graphAnalysis.metrics.${index}.personId`,
      ),
      rank: required(metric.rank, `graphAnalysis.metrics.${index}.rank`),
      value: required(metric.value, `graphAnalysis.metrics.${index}.value`),
    }),
  );
  return {
    graph: graphPageResult(graph),
    metrics,
    run: mapRun(run, "graphAnalysis.run"),
  };
}

function mapPageInfo(
  pageInfo: { endCursor: string | null; hasNextPage: boolean },
  field: string,
): GraphSavedViewPageInfo {
  if (pageInfo.hasNextPage && !pageInfo.endCursor) {
    throw new Error(`The graph response omitted ${field}.endCursor.`);
  }
  return {
    endCursor: pageInfo.endCursor,
    hasNextPage: pageInfo.hasNextPage,
  };
}

async function listSavedViews(after?: string): Promise<GraphSavedViewListPage> {
  const response = await executeBrowserGraphQL(GraphWorkspaceControlsDocument, {
    viewsFirst: VIEW_PAGE_SIZE,
    ...(after ? { viewsAfter: after } : {}),
  });
  if (!response.ok) throw failure(response.errors);
  return {
    nodes: response.data.graphViews.nodes
      .map((view, index) => mapViewSummary(view, `graphViews.nodes.${index}`))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      ),
    pageInfo: mapPageInfo(
      response.data.graphViews.pageInfo,
      "graphViews.pageInfo",
    ),
  };
}

async function loadPositionPage(id: string, after?: string) {
  const response = await executeBrowserGraphQL(GraphSavedViewPageDocument, {
    id,
    positionsFirst: POSITION_PAGE_SIZE,
    ...(after ? { positionsAfter: after } : {}),
  });
  if (!response.ok) throw failure(response.errors);
  const view = response.data.graphView;
  if (!view) return null;
  return {
    pageInfo: mapPageInfo(
      view.positions.pageInfo,
      "graphView.positions.pageInfo",
    ),
    positions: savedViewPositions(view),
    view,
  };
}

async function loadSavedView(id: string) {
  const positionPage = await loadPositionPage(id);
  if (!positionPage) return null;
  const filter = savedViewGraphFilter(positionPage.view);
  const graphResponse = await executeBrowserGraphQL(GraphPageDocument, {
    filter,
  });
  if (!graphResponse.ok) throw failure(graphResponse.errors);
  const graph = required(graphResponse.data.graph, "graph");
  return {
    layoutAlgorithm:
      positionPage.view.layout?.algorithm === "FORCE_ATLAS_2"
        ? ("FORCE_ATLAS_2" as const)
        : ("CIRCLE" as const),
    positionPageInfo: positionPage.pageInfo,
    positions: positionPage.positions,
    result: graphPageResult(graph),
    view: mapViewSummary(positionPage.view),
  };
}

export function createBrowserSavedViewAdapter(
  workspaceIdentity: string,
): GraphSavedViewAdapter {
  void workspaceIdentity;
  return {
    list: listSavedViews,
    async create(input) {
      const response = await executeBrowserGraphQL(CreateGraphViewDocument, {
        input,
      });
      if (!response.ok) throw failure(response.errors);
      return response.data.createGraphView
        ? mapViewSummary(response.data.createGraphView)
        : null;
    },
    async update(input) {
      const response = await executeBrowserGraphQL(UpdateGraphViewDocument, {
        input,
      });
      if (!response.ok) throw failure(response.errors);
      return response.data.updateGraphView
        ? mapViewSummary(response.data.updateGraphView)
        : null;
    },
    async archive(input) {
      const response = await executeBrowserGraphQL(ArchiveGraphViewDocument, {
        input,
      });
      if (!response.ok) throw failure(response.errors);
      return Boolean(response.data.archiveGraphView?.id);
    },
    run: loadSavedView,
    async loadPositions(id, after) {
      const page = await loadPositionPage(id, after);
      return page
        ? { pageInfo: page.pageInfo, positions: page.positions }
        : null;
    },
  };
}

export function createBrowserGraphAnalysisAdapter(
  workspaceIdentity: string,
): GraphAnalysisAdapter {
  void workspaceIdentity;
  return {
    async createSnapshot(input) {
      const response = await executeBrowserGraphQL(
        CreateGraphSnapshotDocument,
        { input },
      );
      if (!response.ok) throw failure(response.errors);
      return response.data.createGraphSnapshot
        ? mapSnapshot(response.data.createGraphSnapshot)
        : null;
    },
    async exportResults(runId, format) {
      const response = await executeBrowserGraphQL(
        GraphAnalysisExportDocument,
        { first: 1000, format, runId },
      );
      if (!response.ok) throw failure(response.errors);
      const exported = response.data.graphAnalysisExport;
      return exported
        ? {
            content: required(exported.content, "graphAnalysisExport.content"),
            contentType: required(
              exported.contentType,
              "graphAnalysisExport.contentType",
            ),
            filename: required(
              exported.filename,
              "graphAnalysisExport.filename",
            ),
            resultCount: required(
              exported.resultCount,
              "graphAnalysisExport.resultCount",
            ),
            truncated: required(
              exported.truncated,
              "graphAnalysisExport.truncated",
            ),
          }
        : null;
    },
    async listRuns(after) {
      const response = await executeBrowserGraphQL(GraphAnalysisRunsDocument, {
        first: ANALYSIS_RUN_PAGE_SIZE,
        ...(after ? { after } : {}),
      });
      if (!response.ok) throw failure(response.errors);
      const connection = required(
        response.data.graphAnalysisRuns,
        "graphAnalysisRuns",
      );
      return {
        nodes: connection.nodes.map((run, index) =>
          mapRun(run, `graphAnalysisRuns.nodes.${index}`),
        ),
        pageInfo: mapPageInfo(
          connection.pageInfo,
          "graphAnalysisRuns.pageInfo",
        ),
      };
    },
    async results(runId, after) {
      const response = await executeBrowserGraphQL(
        GraphAnalysisResultsDocument,
        {
          runId,
          first: ANALYSIS_RESULT_PAGE_SIZE,
          ...(after ? { after } : {}),
        },
      );
      if (!response.ok) throw failure(response.errors);
      const connection = required(
        response.data.graphAnalysisResults,
        "graphAnalysisResults",
      );
      return {
        nodes: connection.nodes.map((item, index): GraphAnalysisResultItem => ({
          createdAt: required(
            item.createdAt,
            `graphAnalysisResults.nodes.${index}.createdAt`,
          ),
          explanation: item.explanation ?? null,
          id: required(item.id, `graphAnalysisResults.nodes.${index}.id`),
          rank: item.rank ?? null,
          resultKind: required(
            item.resultKind,
            `graphAnalysisResults.nodes.${index}.resultKind`,
          ),
          subjectPersonId: item.subjectPersonId ?? null,
          value: item.value ?? null,
        })),
        pageInfo: mapPageInfo(
          connection.pageInfo,
          "graphAnalysisResults.pageInfo",
        ),
      };
    },
    async run(input) {
      const response = await executeBrowserGraphQL(RunGraphAnalysisDocument, {
        input,
      });
      if (!response.ok) throw failure(response.errors);
      return mapAnalysisPayload(response.data.runGraphAnalysis);
    },
    async rerun(input) {
      const response = await executeBrowserGraphQL(RerunGraphAnalysisDocument, {
        input,
      });
      if (!response.ok) throw failure(response.errors);
      return mapAnalysisPayload(response.data.rerunGraphAnalysis);
    },
    async replay(snapshotId) {
      const response = await executeBrowserGraphQL(
        ReplayGraphSnapshotDocument,
        { input: { snapshotId } },
      );
      if (!response.ok) throw failure(response.errors);
      const replay = response.data.replayGraphSnapshot;
      return replay
        ? {
            snapshot: replay.snapshot
              ? mapSnapshot(replay.snapshot, "replayGraphSnapshot.snapshot")
              : null,
            valid: required(replay.valid, "replayGraphSnapshot.valid"),
          }
        : null;
    },
  };
}
