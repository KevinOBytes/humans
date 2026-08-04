import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import type { RequestOperationLimiter } from "@/graphql/operation-limiter";
import {
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import type { Database } from "@/modules/auth/bootstrap-admin";
import type { Task12Metrics } from "@/modules/search/metrics";

import {
  calculateGraphMetrics,
  GRAPH_ANALYSIS_ALGORITHMS,
  GRAPH_ANALYSIS_CONTRACTS,
  graphAnalysisCapViolation,
  graphAnalysisConfiguration,
  type GraphAnalysisAlgorithm,
} from "./metrics";
import {
  createGraphRepository,
  type GraphPersonRow,
  type GraphRelationshipRow,
  type GraphViewRow,
} from "./repository";
import { normalizeGraphFilter, type GraphFilterInput } from "./transform";
import type {
  GraphEdge,
  GraphNode,
  GraphPosition,
  GraphRelationshipState,
  GraphResult,
  NormalizedGraphFilter,
} from "./types";
import { GRAPH_FINGERPRINT_VERSION } from "./types";
import {
  createGraphSnapshotManifest,
  graphSnapshotManifestMaterial,
  GRAPH_RUNTIME_CONTRACT,
  GRAPH_SNAPSHOT_MANIFEST_LIMITS,
  type GraphAuthorizationVector,
  validateGraphSnapshotReplay,
  validateStoredGraphSnapshotManifest,
} from "./snapshot-manifest";
import {
  ANALYSIS_READ_OPERATION_CLASS,
  ANALYSIS_READ_CLIENT_POLICY,
  ANALYSIS_READ_POLICY,
  analysisResultReadCost,
  analysisRunListReadCost,
  analysisRunReadCost,
} from "./analysis-read-limits";
import {
  serializeAnalysisResultsCsv,
  serializeAnalysisResultsJson,
} from "./export";

export type GraphServiceContext = ResearchServiceContext & {
  cursorHmacKey: string;
  metrics: Task12Metrics;
  operationLimiter: RequestOperationLimiter;
};

export type GraphViewLayout = {
  version: "graph-layout-v1";
  algorithm: "CIRCLE" | "FORCE_ATLAS_2";
  settings: {
    barnesHutOptimize: boolean;
    gravity: number;
    scalingRatio: number;
    slowDown: number;
  };
};
export type GraphViewAppearance = {
  version: "graph-appearance-v1";
  palette: "DEFAULT" | "MONOCHROME";
  showLabels: boolean;
};
export type GraphViewLayoutInputValue = {
  algorithm?: GraphViewLayout["algorithm"] | null;
  settings?: {
    barnesHutOptimize?: boolean | null;
    gravity?: number | null;
    scalingRatio?: number | null;
    slowDown?: number | null;
  } | null;
};
export type GraphViewAppearanceInputValue = {
  palette?: GraphViewAppearance["palette"] | null;
  showLabels?: boolean | null;
};
export type GraphViewRecord = GraphViewRow & {
  filter: NormalizedGraphFilter;
  layoutValue: GraphViewLayout;
  appearanceValue: GraphViewAppearance;
};
export type GraphViewSummary = GraphViewRecord;
export type GraphViewConnection = {
  nodes: GraphViewSummary[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};
export type GraphPositionConnection = {
  nodes: GraphPosition[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};
export type AnalysisRunRecord = Awaited<
  ReturnType<
    ReturnType<typeof createGraphRepository>["getAuthorizedAnalysisRun"]
  >
>;
export type AnalysisRunConnection = {
  nodes: NonNullable<AnalysisRunRecord>[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};
export type AnalysisResultRecord = Awaited<
  ReturnType<ReturnType<typeof createGraphRepository>["getAnalysisResults"]>
>[number];
export type AnalysisResultConnection = {
  nodes: AnalysisResultRecord[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};

const READ_POLICY = {
  capacity: 2_000,
  refillAmount: 2_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const ANALYSIS_POLICY = {
  capacity: 4_000,
  refillAmount: 4_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const ANALYSIS_CLIENT_POLICY = {
  capacity: 4_000,
  refillAmount: 4_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const SNAPSHOT_POLICY = {
  capacity: 8_000,
  refillAmount: 8_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const SNAPSHOT_CLIENT_POLICY = {
  capacity: 8_000,
  refillAmount: 8_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const ANALYSIS_EXPORT_LIMIT = 1_000;
const MAX_VIEW_POSITIONS = 10_000;
const VIEW_POSITION_BATCH_SIZE = 500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VIEW_CURSOR_ORDER = "graph-view-name-asc";
const POSITION_CURSOR_ORDER = "graph-view-position-person-asc";
const ANALYSIS_RUN_CURSOR_ORDER = "graph-analysis-run-id-asc";
const ANALYSIS_RESULT_CURSOR_ORDER = "graph-analysis-result-rank-id-asc";

function graphCost(input: GraphFilterInput) {
  const bounded = (
    value: number | null | undefined,
    fallback: number,
    maximum: number,
  ) =>
    Number.isInteger(value)
      ? Math.min(Math.max(value ?? fallback, 0), maximum)
      : maximum;
  const nodes = bounded(input.nodeLimit, 1_000, 10_000);
  const edges = bounded(input.edgeLimit, 4_000, 25_000);
  const depth = bounded(input.depth, input.mode === "NEIGHBORHOOD" ? 1 : 0, 4);
  return 250 + Math.ceil(nodes / 100) + Math.ceil(edges / 500) + depth * 10;
}

function viewPositionCost(limit: number) {
  return 25 + Math.ceil(limit / 25);
}

function normalizeUuid(value: string, message: string) {
  if (!UUID_PATTERN.test(value))
    throw createGraphQLError("VALIDATION_FAILED", message);
  return value.toLowerCase();
}

function encodeViewCursor(row: Pick<GraphViewRow, "id" | "name">) {
  return Buffer.from(
    JSON.stringify({ v: 1, o: VIEW_CURSOR_ORDER, n: row.name, i: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeViewCursor(value: string | null) {
  if (value === null) return null;
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      throw new Error("invalid cursor");
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      decoded.v !== 1 ||
      decoded.o !== VIEW_CURSOR_ORDER ||
      typeof decoded.n !== "string" ||
      typeof decoded.i !== "string" ||
      !UUID_PATTERN.test(decoded.i)
    )
      throw new Error("invalid cursor");
    return { name: decoded.n, id: decoded.i.toLowerCase() };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function encodePositionCursor(viewId: string, personId: string) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: POSITION_CURSOR_ORDER,
      g: viewId,
      i: personId,
    }),
    "utf8",
  ).toString("base64url");
}

function decodePositionCursor(value: string | null, viewId: string) {
  if (value === null) return null;
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      throw new Error("invalid cursor");
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      decoded.v !== 1 ||
      decoded.o !== POSITION_CURSOR_ORDER ||
      decoded.g !== viewId ||
      typeof decoded.i !== "string" ||
      !UUID_PATTERN.test(decoded.i)
    )
      throw new Error("invalid cursor");
    return decoded.i.toLowerCase();
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function analysisCursorSignature(secret: string, body: string): string {
  if (!/^[0-9a-f]{64}$/iu.test(secret))
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update("humans:graph-analysis-cursor:v1\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function encodeAnalysisCursor(
  payload: Readonly<Record<string, unknown>>,
  secret: string,
) {
  const body = Buffer.from(canonical(payload), "utf8").toString("base64url");
  return `${body}.${analysisCursorSignature(secret, body)}`;
}

function decodeAnalysisCursor(value: string) {
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u.test(value))
    throw new Error("invalid cursor");
  const [body = "", signature = ""] = value.split(".");
  const bytes = Buffer.from(body, "base64url");
  if (bytes.length > 1_024 || bytes.toString("base64url") !== body)
    throw new Error("invalid cursor");
  return {
    body,
    decoded: JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
    signature,
  };
}

function encodeAnalysisRunCursor(
  row: { id: string },
  workspaceId: string,
  secret: string,
) {
  return encodeAnalysisCursor(
    {
      v: 1,
      p: "humans.graph.analysis-runs.cursor.v1",
      o: ANALYSIS_RUN_CURSOR_ORDER,
      q: "analysis-runs",
      w: workspaceId,
      i: row.id,
    },
    secret,
  );
}

function decodeAnalysisRunCursor(
  value: string | null,
  workspaceId: string,
  secret: string,
) {
  if (value === null) return null;
  try {
    const { body, decoded, signature } = decodeAnalysisCursor(value);
    const expected = analysisCursorSignature(secret, body);
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      ) ||
      Reflect.ownKeys(decoded).length !== 6 ||
      decoded.v !== 1 ||
      decoded.p !== "humans.graph.analysis-runs.cursor.v1" ||
      decoded.o !== ANALYSIS_RUN_CURSOR_ORDER ||
      decoded.q !== "analysis-runs" ||
      decoded.w !== workspaceId ||
      typeof decoded.i !== "string" ||
      !UUID_PATTERN.test(decoded.i)
    )
      throw new Error("invalid cursor");
    return decoded.i.toLowerCase();
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function encodeAnalysisResultCursor(
  row: { id: string; rank: number | null },
  runId: string,
  workspaceId: string,
  secret: string,
) {
  return encodeAnalysisCursor(
    {
      v: 1,
      p: "humans.graph.analysis-results.cursor.v1",
      o: ANALYSIS_RESULT_CURSOR_ORDER,
      u: runId,
      w: workspaceId,
      r: row.rank,
      i: row.id,
    },
    secret,
  );
}

function decodeAnalysisResultCursor(
  value: string | null,
  runId: string,
  workspaceId: string,
  secret: string,
) {
  if (value === null) return null;
  try {
    const { body, decoded, signature } = decodeAnalysisCursor(value);
    const expected = analysisCursorSignature(secret, body);
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      ) ||
      Reflect.ownKeys(decoded).length !== 7 ||
      decoded.v !== 1 ||
      decoded.p !== "humans.graph.analysis-results.cursor.v1" ||
      decoded.o !== ANALYSIS_RESULT_CURSOR_ORDER ||
      decoded.u !== runId ||
      decoded.w !== workspaceId ||
      (decoded.r !== null &&
        (!Number.isInteger(decoded.r) || Number(decoded.r) < 1)) ||
      typeof decoded.i !== "string" ||
      !UUID_PATTERN.test(decoded.i)
    )
      throw new Error("invalid cursor");
    return {
      id: decoded.i.toLowerCase(),
      rank: decoded.r === null ? null : Number(decoded.r),
    };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function graphFingerprint(
  filter: NormalizedGraphFilter,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
) {
  return createHash("sha256")
    .update(
      canonical({
        version: GRAPH_FINGERPRINT_VERSION,
        filter,
        people: nodes.map(({ id, version }) => [id, version]),
        relationships: edges.map(({ id, version }) => [id, version]),
      }),
    )
    .digest("hex");
}

function toNode(row: GraphPersonRow): GraphNode {
  return {
    id: row.id,
    displayName: row.displayName,
    sortName: row.sortName,
    status: row.status,
    sensitivity: row.sensitivity,
    version: row.version,
  };
}

function toEdge(row: GraphRelationshipRow): GraphEdge {
  return {
    id: row.id,
    relationshipId: row.id,
    source: row.sourcePersonId,
    target: row.targetPersonId,
    relationshipTypeId: row.relationshipTypeId,
    relationshipTypeVersion: row.relationshipTypeVersion,
    forwardLabel: row.labelOverride ?? row.forwardLabel,
    inverseLabel: row.labelOverride ?? row.inverseLabel,
    directed: row.directed,
    state: row.state as GraphRelationshipState,
    sensitivity: row.sensitivity,
    confidence: Number(row.confidence),
    strength: row.strength === null ? null : Number(row.strength),
    temporalSemantics: row.temporalSemantics,
    temporalPrecision: row.temporalPrecision,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    version: row.version,
  };
}

function isStatementTimeout(error: unknown): boolean {
  let candidate = error;
  for (
    let index = 0;
    index < 4 && candidate && typeof candidate === "object";
    index += 1
  ) {
    if ((candidate as { code?: string }).code === "57014") return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

function normalizeViewName(value: string) {
  const name = value.trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 120)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The graph view name is invalid.",
    );
  return name;
}

function normalizeFilterOrError(
  input: GraphFilterInput,
): NormalizedGraphFilter {
  try {
    return normalizeGraphFilter(input);
  } catch {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The graph filter is invalid.",
    );
  }
}

function normalizeLayout(
  value?: GraphViewLayoutInputValue | null,
): GraphViewLayout {
  const settings = value?.settings;
  const number = (
    candidate: number | null | undefined,
    fallback: number,
    min: number,
    max: number,
  ) =>
    candidate == null
      ? fallback
      : Number.isFinite(candidate) && candidate >= min && candidate <= max
        ? candidate
        : (() => {
            throw createGraphQLError(
              "VALIDATION_FAILED",
              "The graph layout is invalid.",
            );
          })();
  const algorithm = value?.algorithm ?? "CIRCLE";
  if (algorithm !== "CIRCLE" && algorithm !== "FORCE_ATLAS_2")
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The graph layout is invalid.",
    );
  return {
    version: "graph-layout-v1",
    algorithm,
    settings: {
      barnesHutOptimize: settings?.barnesHutOptimize ?? true,
      gravity: number(settings?.gravity, 1, 0, 20),
      scalingRatio: number(settings?.scalingRatio, 2, 0.1, 100),
      slowDown: number(settings?.slowDown, 1, 0.1, 100),
    },
  };
}

function normalizeAppearance(
  value?: GraphViewAppearanceInputValue | null,
): GraphViewAppearance {
  const palette = value?.palette ?? "DEFAULT";
  if (palette !== "DEFAULT" && palette !== "MONOCHROME")
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The graph appearance is invalid.",
    );
  return {
    version: "graph-appearance-v1",
    palette,
    showLabels: value?.showLabels ?? true,
  };
}

function normalizePositions(
  values: readonly GraphPosition[] | null | undefined,
) {
  const ids = new Set<string>();
  const positions = [...(values ?? [])]
    .map((position) => ({
      ...position,
      id: normalizeUuid(position.id, "The saved graph positions are invalid."),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    positions.length > 10_000 ||
    positions.some(
      ({ id, x, y }) =>
        ids.has(id) ||
        (ids.add(id), false) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        Math.abs(x) > 1_000_000 ||
        Math.abs(y) > 1_000_000,
    )
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The saved graph positions are invalid.",
    );
  }
  return positions;
}

export function createGraphService(context: GraphServiceContext) {
  const personVisibility = ({
    id,
    sensitivity,
  }: {
    id: Parameters<typeof resourceVisibilitySql>[1]["id"];
    sensitivity: Parameters<typeof resourceVisibilitySql>[1]["sensitivity"];
  }) =>
    resourceVisibilitySql(context, { resourceKind: "person", id, sensitivity });
  const relationshipVisibility = ({
    id,
    sensitivity,
  }: {
    id: Parameters<typeof resourceVisibilitySql>[1]["id"];
    sensitivity: Parameters<typeof resourceVisibilitySql>[1]["sensitivity"];
  }) =>
    resourceVisibilitySql(context, {
      resourceKind: "relationship",
      id,
      sensitivity,
    });
  const audit = createAuditService(context);

  async function buildGraph(
    database: Database,
    filter: NormalizedGraphFilter,
  ): Promise<GraphResult> {
    const repository = createGraphRepository(database);
    const nodes = new Map<string, GraphNode>();
    const edgeRows = new Map<string, GraphRelationshipRow>();
    let nodesTruncated = false;
    let edgesTruncated = false;

    if (filter.mode === "WORKSPACE") {
      const peopleRows = await repository.listVisiblePeople({
        workspaceId: context.workspaceId,
        filter,
        personVisibility,
        limit: filter.nodeLimit + 1,
      });
      nodesTruncated = peopleRows.length > filter.nodeLimit;
      for (const row of peopleRows.slice(0, filter.nodeLimit))
        nodes.set(row.id, toNode(row));
      const rows = await repository.listVisibleEdgesAmongPeople({
        workspaceId: context.workspaceId,
        personIds: [...nodes.keys()],
        filter,
        personVisibility,
        relationshipVisibility,
        limit: filter.edgeLimit + 1,
      });
      edgesTruncated = rows.length > filter.edgeLimit;
      for (const row of rows.slice(0, filter.edgeLimit))
        edgeRows.set(row.id, row);
    } else {
      const roots = await repository.getVisiblePeopleByIds({
        workspaceId: context.workspaceId,
        ids: filter.rootPersonIds,
        filter,
        personVisibility,
      });
      if (roots.length !== filter.rootPersonIds.length) {
        throw createGraphQLError(
          "NOT_FOUND",
          "One or more graph roots were not found.",
        );
      }
      nodesTruncated = roots.length > filter.nodeLimit;
      for (const row of roots.slice(0, filter.nodeLimit))
        nodes.set(row.id, toNode(row));
      let frontier = [...nodes.keys()].sort();
      for (
        let depth = 0;
        depth < filter.depth &&
        frontier.length &&
        (filter.edgeLimit === 0 || edgeRows.size < filter.edgeLimit);
        depth += 1
      ) {
        const rows = await repository.listVisibleIncidentEdges({
          workspaceId: context.workspaceId,
          frontierIds: frontier,
          filter,
          personVisibility,
          relationshipVisibility,
          limit: filter.edgeLimit + 1,
        });
        const next = new Set<string>();
        for (const row of rows) {
          if (edgeRows.has(row.id)) continue;
          const missing = [row.source, row.target].filter(
            (person) => !nodes.has(person.id),
          );
          if (nodes.size + missing.length > filter.nodeLimit) {
            nodesTruncated = true;
            continue;
          }
          if (edgeRows.size >= filter.edgeLimit) {
            edgesTruncated = true;
            break;
          }
          for (const person of missing) {
            nodes.set(person.id, toNode(person));
            next.add(person.id);
          }
          edgeRows.set(row.id, row);
        }
        frontier = [...next].sort();
      }
      if (edgeRows.size < filter.edgeLimit && nodes.size) {
        const rows = await repository.listVisibleEdgesAmongPeople({
          workspaceId: context.workspaceId,
          personIds: [...nodes.keys()],
          filter,
          personVisibility,
          relationshipVisibility,
          limit: filter.edgeLimit + 1,
        });
        for (const row of rows) {
          if (edgeRows.has(row.id)) continue;
          if (edgeRows.size >= filter.edgeLimit) {
            edgesTruncated = true;
            break;
          }
          edgeRows.set(row.id, row);
        }
      }
    }

    if (!filter.includeIsolates) {
      const connected = new Set(
        [...edgeRows.values()].flatMap((edge) => [
          edge.sourcePersonId,
          edge.targetPersonId,
        ]),
      );
      for (const id of nodes.keys())
        if (!connected.has(id) && !filter.rootPersonIds.includes(id))
          nodes.delete(id);
    }
    const graphNodes = [...nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const graphEdges = [...edgeRows.values()]
      .map(toEdge)
      .filter((edge) => nodes.has(edge.source) && nodes.has(edge.target))
      .sort((left, right) => left.id.localeCompare(right.id));
    const reasons = [
      ...(nodesTruncated ? ["NODE_LIMIT"] : []),
      ...(edgesTruncated ? ["EDGE_LIMIT"] : []),
    ];
    return {
      nodes: graphNodes,
      edges: graphEdges,
      normalizedFilter: filter,
      limits: {
        requestedNodeLimit: filter.nodeLimit,
        requestedEdgeLimit: filter.edgeLimit,
        returnedNodeCount: graphNodes.length,
        returnedEdgeCount: graphEdges.length,
        nodesTruncated,
        edgesTruncated,
        reasons,
      },
      fingerprint: graphFingerprint(filter, graphNodes, graphEdges),
      generatedAt: new Date().toISOString(),
    };
  }

  async function coherentRead(filter: NormalizedGraphFilter) {
    try {
      return await context.database.transaction(
        async (transaction) => {
          await transaction.execute(
            sql`set local statement_timeout = '2500ms'`,
          );
          return buildGraph(transaction as Database, filter);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    } catch (error) {
      if (isStatementTimeout(error))
        throw createGraphQLError(
          "RATE_LIMITED",
          "The graph query exceeded its bounded execution time.",
          { requestId: context.requestId },
        );
      throw error;
    }
  }

  const summarizeView = (row: GraphViewRow): GraphViewSummary => ({
    ...row,
    filter: normalizeFilterOrError(row.filters as GraphFilterInput),
    layoutValue: normalizeLayout(row.layout as GraphViewLayoutInputValue),
    appearanceValue: normalizeAppearance(
      row.appearance as GraphViewAppearanceInputValue,
    ),
  });

  async function visibleIds(
    database: Database,
    ids: readonly string[],
    filter: NormalizedGraphFilter,
  ) {
    const repository = createGraphRepository(database);
    const visible = new Set<string>();
    for (
      let offset = 0;
      offset < ids.length;
      offset += VIEW_POSITION_BATCH_SIZE
    ) {
      const rows = await repository.getVisiblePeopleByIds({
        workspaceId: context.workspaceId,
        ids: ids.slice(offset, offset + VIEW_POSITION_BATCH_SIZE),
        filter,
        personVisibility,
      });
      for (const row of rows) visible.add(row.id);
    }
    return visible;
  }

  async function rootsAreVisible(
    database: Database,
    filter: NormalizedGraphFilter,
  ) {
    const ids = await visibleIds(database, filter.rootPersonIds, filter);
    return filter.rootPersonIds.every((id) => ids.has(id));
  }

  async function authorizeViewRoots(
    row: GraphViewRow,
    database: Database,
  ): Promise<GraphViewRecord> {
    const summary = summarizeView(row);
    if (!(await rootsAreVisible(database, summary.filter)))
      throw createGraphQLError("NOT_FOUND", "The graph view was not found.");
    return summary;
  }

  function parseStoredPosition(node: {
    personId: string;
    positionX: string | null;
    positionY: string | null;
  }): GraphPosition {
    const x = Number(node.positionX);
    const y = Number(node.positionY);
    if (
      node.positionX === null ||
      node.positionY === null ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 1_000_000 ||
      Math.abs(y) > 1_000_000
    )
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The saved graph positions are invalid.",
      );
    return { id: node.personId, x, y };
  }

  async function authorizeAllViewPositions(
    row: GraphViewRow,
    database: Database,
    filter: NormalizedGraphFilter,
  ) {
    const repository = createGraphRepository(database);
    let afterPersonId: string | null = null;
    let storedCount = 0;
    while (true) {
      const rows = await repository.viewNodes({
        workspaceId: context.workspaceId,
        viewId: row.id,
        afterPersonId,
        limit: VIEW_POSITION_BATCH_SIZE,
      });
      if (!rows.length) return;
      storedCount += rows.length;
      if (storedCount > MAX_VIEW_POSITIONS)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The saved graph positions are invalid.",
        );
      const positions = rows.map(parseStoredPosition);
      const visible = await visibleIds(
        database,
        positions.map(({ id }) => id),
        filter,
      );
      if (positions.some(({ id }) => !visible.has(id)))
        throw createGraphQLError("NOT_FOUND", "The graph view was not found.");
      if (rows.length < VIEW_POSITION_BATCH_SIZE) return;
      afterPersonId = rows.at(-1)?.personId ?? null;
    }
  }

  async function authorizeSnapshotView(
    database: Database,
    graphViewId: string | null,
  ): Promise<GraphViewRecord | null> {
    if (!graphViewId) return null;
    const repository = createGraphRepository(database);
    const view = await repository.getView({
      workspaceId: context.workspaceId,
      id: graphViewId,
      actorId: context.actor.type === "user" ? context.actor.id : null,
    });
    if (!view)
      throw createGraphQLError("NOT_FOUND", "The graph view was not found.");
    const summary = await authorizeViewRoots(view, database);
    await authorizeAllViewPositions(view, database, summary.filter);
    return summary;
  }

  function validateAnalysisCaps(
    filter: NormalizedGraphFilter,
    algorithm: GraphAnalysisAlgorithm,
  ) {
    const violation = graphAnalysisCapViolation(
      filter.nodeLimit,
      filter.edgeLimit,
      algorithm,
    );
    if (violation)
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The graph analysis request exceeds the selected algorithm limits.",
      );
  }

  async function currentAuthorizationVector(
    database: Database,
    graph: GraphResult,
  ): Promise<GraphAuthorizationVector> {
    const permissionKeys = [...context.permissions].sort();
    if (context.actor.type !== "user")
      return {
        actorRole: null,
        grantVersions: [],
        permissionKeys,
        policyVersions: [],
        principalId: context.actor.principalId,
      };
    const personIds = JSON.stringify(graph.nodes.map(({ id }) => id));
    const relationshipIds = JSON.stringify(graph.edges.map(({ id }) => id));
    const rows = (await database.execute(sql`
      SELECT
        rg.id AS "grantId",
        rg.deleted_at IS NOT NULL AS "grantDeleted",
        rg.member_id AS "memberId",
        rg.policy_id AS "policyId",
        rg.resource_id AS "resourceId",
        rg.resource_kind AS "resourceKind",
        rg.role,
        rg.state AS "grantState",
        rg.valid_from AS "validFrom",
        rg.valid_until AS "validUntil",
        rg.version AS "grantVersion",
        ap.id AS "policyRowId",
        ap.deleted_at IS NOT NULL AS "policyDeleted",
        ap.resource_kinds AS "resourceKinds",
        ap.sensitivity_ceiling AS "sensitivityCeiling",
        ap.state AS "policyState",
        ap.version AS "policyVersion",
        (
          rg.state = 'active'
          AND rg.deleted_at IS NULL
          AND (rg.valid_from IS NULL OR rg.valid_from <= CURRENT_TIMESTAMP)
          AND (rg.valid_until IS NULL OR rg.valid_until >= CURRENT_TIMESTAMP)
          AND ap.state = 'active'
          AND ap.deleted_at IS NULL
        ) AS effective
      FROM resource_grants rg
      INNER JOIN access_policies ap
        ON ap.workspace_id = rg.workspace_id
       AND ap.id = rg.policy_id
      WHERE rg.workspace_id = ${context.workspaceId}::uuid
        AND (rg.member_id = ${context.actor.memberId} OR rg.role = ${context.actor.role})
        AND (
          (rg.resource_kind = 'person' AND rg.resource_id::text IN (
            SELECT jsonb_array_elements_text(${personIds}::jsonb)
          ))
          OR (rg.resource_kind = 'relationship' AND rg.resource_id::text IN (
            SELECT jsonb_array_elements_text(${relationshipIds}::jsonb)
          ))
        )
      ORDER BY rg.id ASC
      LIMIT ${GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationGrants + 1}
    `)) as unknown as Array<{
      effective: boolean;
      grantId: string;
      grantDeleted: boolean;
      grantState: string;
      grantVersion: number;
      memberId: string | null;
      policyId: string;
      policyRowId: string;
      policyDeleted: boolean;
      policyState: string;
      policyVersion: number;
      resourceId: string;
      resourceKind: string;
      resourceKinds: string[];
      role: string | null;
      sensitivityCeiling: string;
      validFrom: Date | null;
      validUntil: Date | null;
    }>;
    if (
      rows.length > GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationGrants ||
      permissionKeys.length >
        GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPermissionKeys
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The graph authorization snapshot exceeds supported bounds.",
      );
    }
    const policyVersions = [
      ...new Map(
        rows.map((row) => [
          row.policyRowId,
          {
            deleted: row.policyDeleted,
            id: row.policyRowId,
            resourceKinds: row.resourceKinds,
            sensitivityCeiling: row.sensitivityCeiling,
            state: row.policyState,
            version: row.policyVersion,
          },
        ]),
      ).values(),
    ];
    if (
      policyVersions.length >
        GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPolicies ||
      policyVersions.some(
        ({ resourceKinds }) =>
          resourceKinds.length >
          GRAPH_SNAPSHOT_MANIFEST_LIMITS.authorizationPolicyResourceKinds,
      )
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The graph authorization snapshot exceeds supported bounds.",
      );
    }
    return {
      actorRole: context.actor.role,
      grantVersions: rows.map((row) => ({
        deleted: row.grantDeleted,
        effective: row.effective,
        id: row.grantId,
        memberId: row.memberId,
        policyId: row.policyId,
        resourceId: row.resourceId,
        resourceKind: row.resourceKind,
        role: row.role,
        state: row.grantState,
        validFrom: row.validFrom?.toISOString() ?? null,
        validUntil: row.validUntil?.toISOString() ?? null,
        version: row.grantVersion,
      })),
      permissionKeys,
      policyVersions,
      principalId: context.actor.principalId,
    };
  }

  async function currentManifest(
    database: Database,
    input: {
      algorithm: GraphAnalysisAlgorithm;
      filter: NormalizedGraphFilter;
      graph: GraphResult;
    },
  ) {
    const relationshipTypeVersions = [
      ...new Map(
        input.graph.edges.map((edge) => [
          edge.relationshipTypeId,
          {
            id: edge.relationshipTypeId,
            version: edge.relationshipTypeVersion ?? 1,
          },
        ]),
      ).values(),
    ];
    return createGraphSnapshotManifest({
      actorKind: context.actor.type === "apiKey" ? "API_KEY" : "USER",
      actorPrincipalId: context.actor.principalId,
      algorithm: input.algorithm,
      algorithmConfiguration: graphAnalysisConfiguration(input.algorithm),
      algorithmVersion: GRAPH_ANALYSIS_CONTRACTS[input.algorithm].version,
      authorization: await currentAuthorizationVector(database, input.graph),
      query: input.filter,
      personVersions: input.graph.nodes.map(({ id, version }) => ({
        id,
        version,
      })),
      relationshipVersions: input.graph.edges.map(
        ({ id, relationshipTypeId, version }) => ({
          id,
          relationshipTypeId,
          version,
        }),
      ),
      relationshipTypeVersions,
      runtimeContract: GRAPH_RUNTIME_CONTRACT,
      workspaceId: context.workspaceId,
    });
  }

  async function persistSnapshot(
    database: Database,
    input: {
      algorithm: GraphAnalysisAlgorithm;
      filter: NormalizedGraphFilter;
      graph: GraphResult;
      graphViewId?: string | null;
    },
  ) {
    if (input.graph.limits.nodesTruncated || input.graph.limits.edgesTruncated)
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The graph selection is truncated and cannot be snapshotted.",
      );
    const manifest = await currentManifest(database, input);
    const repository = createGraphRepository(database);
    const snapshot = await repository.insertSnapshot({
      id: newId(),
      workspaceId: context.workspaceId,
      graphViewId: input.graphViewId ?? null,
      manifestSchema: manifest.manifestSchema,
      manifestHash: manifest.manifestHash,
      manifestMaterial: graphSnapshotManifestMaterial(manifest),
      queryInput: input.filter,
      queryHash: manifest.queryHash,
      authorizationHash: manifest.authorizationHash,
      actorPrincipalId: context.actor.principalId,
      actorKind: context.actor.type === "apiKey" ? "API_KEY" : "USER",
      includedPersonVersions: Object.fromEntries(
        input.graph.nodes.map(({ id, version }) => [id, version]),
      ),
      includedRelationshipVersions: Object.fromEntries(
        input.graph.edges.map(({ id, version }) => [id, version]),
      ),
      includedRelationshipTypeVersions: Object.fromEntries(
        manifest.relationshipTypeVersions.map(({ id, version }) => [
          id,
          version,
        ]),
      ),
      algorithm: input.algorithm,
      algorithmVersion: manifest.algorithmVersion,
      algorithmConfigHash: manifest.algorithmConfigHash,
      algorithmConfiguration: manifest.algorithmConfiguration,
      runtimeContract: manifest.runtimeContract,
      generatedAt: new Date(),
      createdBy: context.actor.principalId,
    });
    return { manifest, snapshot };
  }

  async function persistAnalysis(
    database: Database,
    input: {
      graph: GraphResult;
      filter: NormalizedGraphFilter;
      algorithm: GraphAnalysisAlgorithm;
      graphViewId?: string | null;
      sourceSnapshotId?: string | null;
    },
  ) {
    const repository = createGraphRepository(database);
    const algorithmConfiguration = graphAnalysisConfiguration(input.algorithm);
    const metrics = calculateGraphMetrics(
      input.graph,
      input.algorithm,
      algorithmConfiguration,
    );
    const runId = newId();
    const now = new Date();
    const algorithmContract = GRAPH_ANALYSIS_CONTRACTS[input.algorithm];
    const { manifest, snapshot } = await persistSnapshot(database, input);
    const snapshotId = snapshot.id;
    await repository.insertAnalysisRun({
      id: runId,
      workspaceId: context.workspaceId,
      algorithm: input.algorithm,
      algorithmVersion: algorithmContract.version,
      configurationHash: manifest.algorithmConfigHash,
      graphSnapshotId: snapshotId,
      actorPrincipalId: context.actor.principalId,
      actorKind: context.actor.type === "apiKey" ? "API_KEY" : "USER",
      configuration: algorithmConfiguration,
      state: "running",
      startedAt: now,
      completedAt: null,
      createdBy: context.actor.principalId,
    });
    await repository.insertAnalysisResults(
      metrics.map((metric) => {
        const payload = {
          algorithmVersion: metric.algorithmVersion,
          metricKey: metric.metricKey,
          personId: metric.personId,
          rank: metric.rank,
          value: metric.value,
        };
        return {
          id: newId(),
          workspaceId: context.workspaceId,
          analysisRunId: runId,
          resultKind: metric.metricKey,
          payloadSchema: "humans.graph-analysis-result.v1",
          payloadHash: createHash("sha256")
            .update("humans.graph-analysis-result.v1\0")
            .update(canonical(payload))
            .digest("hex"),
          exportLabel: metric.metricKey,
          subjectPersonId: metric.personId,
          numericValue: String(metric.value),
          rank: metric.rank,
          explanation: metric.explanation,
        };
      }),
    );
    await repository.insertPersonMetrics(
      metrics.map((metric) => ({
        id: newId(),
        workspaceId: context.workspaceId,
        graphSnapshotId: snapshotId,
        personId: metric.personId,
        metricKey: metric.metricKey,
        metricValue: String(metric.value),
        rank: metric.rank,
        algorithmVersion: metric.algorithmVersion,
      })),
    );
    const run = await repository.finalizeAnalysisRun({
      completedAt: new Date(),
      id: runId,
      workspaceId: context.workspaceId,
    });
    await audit.write(database, {
      action: input.sourceSnapshotId
        ? "graph_analysis.rerun"
        : "graph_analysis.run",
      changedFields: ["algorithm", "snapshot", "results"],
      metadata: {
        algorithm: input.algorithm,
        nodeCount: input.graph.nodes.length,
        edgeCount: input.graph.edges.length,
        fingerprint: input.graph.fingerprint,
      },
      resourceKind: "analysisRun",
      resourceId: runId,
    });
    return { run, metrics, graph: input.graph };
  }

  function verifyAnalysisResults(
    rows: readonly AnalysisResultRecord[],
    algorithmVersion: string,
  ): void {
    for (const row of rows) {
      const numericValue = Number(row.numericValue);
      const expected = createHash("sha256")
        .update("humans.graph-analysis-result.v1\0")
        .update(
          canonical({
            algorithmVersion,
            metricKey: row.resultKind,
            personId: row.subjectPersonId,
            rank: row.rank,
            value: numericValue,
          }),
        )
        .digest("hex");
      if (
        row.payloadSchema !== "humans.graph-analysis-result.v1" ||
        !Number.isFinite(numericValue) ||
        row.payloadHash !== expected
      )
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The graph analysis results are no longer valid.",
        );
    }
  }

  return {
    async query(input: GraphFilterInput) {
      await context.operationLimiter.consume({
        operationClass: "graph.read",
        cost: graphCost(input),
        policy: READ_POLICY,
      });
      const filter = normalizeFilterOrError(input);
      return coherentRead(filter);
    },
    async listViews(input: {
      first?: number | null;
      after?: string | null;
    }): Promise<GraphViewConnection> {
      const page = normalizePagination(input);
      await context.operationLimiter.consume({
        operationClass: "graph.read",
        cost: 10 + page.first,
        policy: READ_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const database = transaction as Database;
            const repository = createGraphRepository(database);
            const rows = await repository.listViews({
              workspaceId: context.workspaceId,
              actorId: context.actor.type === "user" ? context.actor.id : null,
              cursor: decodeViewCursor(page.after),
              personVisibility,
              limit: page.first + 1,
            });
            const summaries = rows.map(summarizeView);
            const nodes = summaries.slice(0, page.first);
            const last = nodes.at(-1);
            return {
              nodes,
              pageInfo: {
                hasNextPage: summaries.length > page.first,
                endCursor: last ? encodeViewCursor(last) : null,
              },
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The graph view query exceeded its bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async getView(id: string): Promise<GraphViewRecord | null> {
      const normalizedId = normalizeUuid(id, "The graph view ID is invalid.");
      await context.operationLimiter.consume({
        operationClass: "graph.read",
        cost: 10,
        policy: READ_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const database = transaction as Database;
            const repository = createGraphRepository(database);
            const row = await repository.getView({
              workspaceId: context.workspaceId,
              id: normalizedId,
              actorId: context.actor.type === "user" ? context.actor.id : null,
            });
            return row ? authorizeViewRoots(row, database) : null;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The graph view query exceeded its bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async listViewPositions(
      id: string,
      input: { first?: number | null; after?: string | null },
    ): Promise<GraphPositionConnection> {
      const viewId = normalizeUuid(id, "The graph view ID is invalid.");
      const first = input.first ?? 25;
      if (!Number.isInteger(first) || first < 1 || first > 250)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "first must be between 1 and 250.",
        );
      const afterPersonId = decodePositionCursor(input.after ?? null, viewId);
      await context.operationLimiter.consume({
        operationClass: "graph.read",
        cost: viewPositionCost(first),
        policy: READ_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const database = transaction as Database;
            const repository = createGraphRepository(database);
            const row = await repository.getView({
              workspaceId: context.workspaceId,
              id: viewId,
              actorId: context.actor.type === "user" ? context.actor.id : null,
            });
            if (!row)
              throw createGraphQLError(
                "NOT_FOUND",
                "The graph view was not found.",
              );
            const summary = await authorizeViewRoots(row, database);
            const rows = await repository.visibleViewNodes({
              workspaceId: context.workspaceId,
              viewId,
              afterPersonId,
              filter: summary.filter,
              personVisibility,
              limit: first + 1,
            });
            const nodes = rows.slice(0, first).map(parseStoredPosition);
            const last = nodes.at(-1);
            return {
              nodes,
              pageInfo: {
                hasNextPage: rows.length > first,
                endCursor: last ? encodePositionCursor(viewId, last.id) : null,
              },
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The saved graph positions exceeded their bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async createView(input: {
      name: string;
      filter: GraphFilterInput;
      layout?: GraphViewLayoutInputValue | null;
      appearance?: GraphViewAppearanceInputValue | null;
      sharing?: "private" | "workspace" | null;
      positions?: readonly GraphPosition[] | null;
    }) {
      if (context.actor.type !== "user")
        throw createGraphQLError(
          "FORBIDDEN",
          "API keys cannot own graph views.",
        );
      const filter = normalizeFilterOrError(input.filter);
      const name = normalizeViewName(input.name);
      const layout = normalizeLayout(input.layout);
      const appearance = normalizeAppearance(input.appearance);
      const sharing = input.sharing ?? "private";
      if (sharing !== "private" && sharing !== "workspace")
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The graph view sharing mode is invalid.",
        );
      const positions = normalizePositions(input.positions);
      await context.operationLimiter.consume({
        operationClass: "graph.read",
        cost: graphCost(input.filter),
        policy: READ_POLICY,
      });
      const authorizedGraph = await coherentRead(filter);
      const authorizedIds = new Set(authorizedGraph.nodes.map(({ id }) => id));
      if (positions.some(({ id }) => !authorizedIds.has(id)))
        throw createGraphQLError(
          "NOT_FOUND",
          "One or more saved graph nodes were not found.",
        );
      return context.database.transaction(async (transaction) => {
        const database = transaction as Database;
        const repository = createGraphRepository(database);
        const row = await repository.createView({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            ownerId: context.actor.id,
            name,
            filters: filter,
            layout,
            appearance,
            sharing,
            createdBy: context.actor.principalId,
            updatedBy: context.actor.principalId,
          },
        });
        await repository.replaceViewNodes({
          workspaceId: context.workspaceId,
          viewId: row.id,
          actorId: context.actor.principalId,
          nodes: positions.map((position) => ({
            id: newId(),
            personId: position.id,
            x: position.x,
            y: position.y,
          })),
        });
        await audit.write(transaction as Database, {
          action: "graph_view.create",
          changedFields: [
            "name",
            "filters",
            "layout",
            "appearance",
            "sharing",
            "positions",
          ],
          resourceKind: "graphView",
          resourceId: row.id,
        });
        return summarizeView(row);
      });
    },
    async updateView(input: {
      id: string;
      expectedVersion: number;
      name?: string | null;
      filter?: GraphFilterInput | null;
      layout?: GraphViewLayoutInputValue | null;
      appearance?: GraphViewAppearanceInputValue | null;
      sharing?: "private" | "workspace" | null;
      positions?: readonly GraphPosition[] | null;
    }) {
      if (context.actor.type !== "user")
        throw createGraphQLError(
          "FORBIDDEN",
          "API keys cannot own graph views.",
        );
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A positive expected version is required.",
        );
      if (
        input.sharing &&
        input.sharing !== "private" &&
        input.sharing !== "workspace"
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The graph view sharing mode is invalid.",
        );
      const normalizedPositions =
        input.positions === undefined || input.positions === null
          ? null
          : normalizePositions(input.positions);
      const viewId = normalizeUuid(input.id, "The graph view ID is invalid.");
      if (input.filter || normalizedPositions)
        await context.operationLimiter.consume({
          operationClass: "graph.read",
          cost: graphCost(input.filter ?? { mode: "WORKSPACE" }),
          policy: READ_POLICY,
        });
      return context.database.transaction(async (transaction) => {
        const database = transaction as Database;
        const repository = createGraphRepository(database);
        const current = await repository.getOwnedViewForUpdate({
          workspaceId: context.workspaceId,
          id: viewId,
          ownerId: context.actor.id,
        });
        if (!current)
          throw createGraphQLError(
            "NOT_FOUND",
            "The graph view was not found.",
          );
        if (current.version !== input.expectedVersion)
          throw createGraphQLError("CONFLICT", "The graph view has changed.");
        if (input.filter || input.positions) {
          const graph = await buildGraph(
            database,
            normalizeFilterOrError(
              input.filter ?? (current.filters as GraphFilterInput),
            ),
          );
          const authorizedIds = new Set(graph.nodes.map(({ id }) => id));
          if (
            (normalizedPositions ?? []).some(({ id }) => !authorizedIds.has(id))
          )
            throw createGraphQLError(
              "NOT_FOUND",
              "One or more saved graph nodes were not found.",
            );
        }
        const patch = {
          ...(input.name !== undefined && input.name !== null
            ? { name: normalizeViewName(input.name) }
            : {}),
          ...(input.filter
            ? { filters: normalizeFilterOrError(input.filter) }
            : {}),
          ...(input.layout ? { layout: normalizeLayout(input.layout) } : {}),
          ...(input.appearance
            ? { appearance: normalizeAppearance(input.appearance) }
            : {}),
          ...(input.sharing ? { sharing: input.sharing } : {}),
          updatedAt: new Date(),
          updatedBy: context.actor.principalId,
        };
        const row = await repository.updateViewIfVersion({
          workspaceId: context.workspaceId,
          id: viewId,
          ownerId: context.actor.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!row)
          throw createGraphQLError("CONFLICT", "The graph view has changed.");
        if (normalizedPositions) {
          await repository.replaceViewNodes({
            workspaceId: context.workspaceId,
            viewId: row.id,
            actorId: context.actor.principalId,
            nodes: normalizedPositions.map((position) => ({
              id: newId(),
              personId: position.id,
              x: position.x,
              y: position.y,
            })),
          });
        }
        await audit.write(transaction as Database, {
          action: "graph_view.update",
          changedFields: Object.keys(patch),
          resourceKind: "graphView",
          resourceId: row.id,
        });
        return summarizeView(row);
      });
    },
    async archiveView(input: { id: string; expectedVersion: number }) {
      if (context.actor.type !== "user")
        throw createGraphQLError(
          "FORBIDDEN",
          "API keys cannot own graph views.",
        );
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A positive expected version is required.",
        );
      const viewId = normalizeUuid(input.id, "The graph view ID is invalid.");
      return context.database.transaction(async (transaction) => {
        const database = transaction as Database;
        const repository = createGraphRepository(database);
        const current = await repository.getOwnedViewForUpdate({
          workspaceId: context.workspaceId,
          id: viewId,
          ownerId: context.actor.id,
        });
        if (!current)
          throw createGraphQLError(
            "NOT_FOUND",
            "The graph view was not found.",
          );
        if (current.version !== input.expectedVersion)
          throw createGraphQLError("CONFLICT", "The graph view has changed.");
        const row = await repository.updateViewIfVersion({
          workspaceId: context.workspaceId,
          id: viewId,
          ownerId: context.actor.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          },
        });
        if (!row)
          throw createGraphQLError("CONFLICT", "The graph view has changed.");
        await audit.write(transaction as Database, {
          action: "graph_view.archive",
          changedFields: ["deletedAt"],
          resourceKind: "graphView",
          resourceId: row.id,
        });
        return summarizeView(row);
      });
    },
    async createSnapshot(input: {
      filter?: GraphFilterInput | null;
      algorithm: GraphAnalysisAlgorithm;
      graphViewId?: string | null;
    }) {
      if (!GRAPH_ANALYSIS_ALGORITHMS.includes(input.algorithm))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The graph analysis algorithm is invalid.",
        );
      const requestedFilter = input.filter
        ? normalizeFilterOrError(input.filter)
        : null;
      if (!requestedFilter && !input.graphViewId)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A graph filter or saved graph view is required.",
        );
      if (requestedFilter)
        validateAnalysisCaps(requestedFilter, input.algorithm);
      try {
        await context.operationLimiter.consume({
          clientPolicy: SNAPSHOT_CLIENT_POLICY,
          operationClass: "graph.snapshot",
          cost: input.filter ? graphCost(input.filter) : 400,
          policy: SNAPSHOT_POLICY,
        });
        const snapshot = await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '5000ms'`,
            );
            const database = transaction as Database;
            let filter = requestedFilter;
            let graphViewId: string | null = null;
            if (input.graphViewId) {
              graphViewId = normalizeUuid(
                input.graphViewId,
                "The graph view ID is invalid.",
              );
              const view = await authorizeSnapshotView(database, graphViewId);
              if (!view)
                throw createGraphQLError(
                  "NOT_FOUND",
                  "The graph view was not found.",
                );
              if (filter && canonical(filter) !== canonical(view.filter))
                throw createGraphQLError(
                  "VALIDATION_FAILED",
                  "The snapshot filter must match the saved graph view.",
                );
              filter = view.filter;
            }
            if (!filter) throw new Error("unreachable graph snapshot filter");
            validateAnalysisCaps(filter, input.algorithm);
            const graph = await buildGraph(database, filter);
            const { snapshot } = await persistSnapshot(database, {
              algorithm: input.algorithm,
              filter,
              graph,
              graphViewId,
            });
            await audit.write(database, {
              action: "graph_snapshot.create",
              changedFields: ["manifest"],
              metadata: {
                algorithm: input.algorithm,
                edgeCount: graph.edges.length,
                nodeCount: graph.nodes.length,
              },
              resourceKind: "graphSnapshot",
              resourceId: snapshot.id,
            });
            return snapshot;
          },
          { isolationLevel: "repeatable read" },
        );
        context.metrics.snapshotCreate({ outcome: "SUCCESS" });
        return snapshot;
      } catch (error) {
        const safeError = isStatementTimeout(error)
          ? createGraphQLError(
              "RATE_LIMITED",
              "The graph snapshot exceeded its bounded execution time.",
              { requestId: context.requestId },
            )
          : error;
        const code =
          safeError && typeof safeError === "object"
            ? (safeError as { extensions?: { code?: string } }).extensions?.code
            : undefined;
        context.metrics.snapshotCreate({
          outcome:
            code === "FORBIDDEN" ||
            code === "NOT_FOUND" ||
            code === "RATE_LIMITED"
              ? "DENIED"
              : "ERROR",
        });
        throw safeError;
      }
    },
    async getSnapshot(id: string) {
      const snapshotId = normalizeUuid(id, "The graph snapshot ID is invalid.");
      await context.operationLimiter.consume({
        clientPolicy: SNAPSHOT_CLIENT_POLICY,
        operationClass: "graph.snapshot",
        cost: 100,
        policy: SNAPSHOT_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const snapshot = await createGraphRepository(
              transaction as Database,
            ).getAuthorizedSnapshot({
              actorId: context.actor.type === "user" ? context.actor.id : null,
              id: snapshotId,
              personVisibility,
              relationshipVisibility,
              workspaceId: context.workspaceId,
            });
            return snapshot &&
              validateStoredGraphSnapshotManifest(snapshot).valid
              ? snapshot
              : null;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The graph snapshot query exceeded its bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async replaySnapshot(id: string) {
      const snapshotId = normalizeUuid(id, "The graph snapshot ID is invalid.");
      try {
        await context.operationLimiter.consume({
          clientPolicy: SNAPSHOT_CLIENT_POLICY,
          operationClass: "graph.replay",
          cost: 800,
          policy: SNAPSHOT_POLICY,
        });
        const result = await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '5000ms'`,
            );
            const database = transaction as Database;
            const repository = createGraphRepository(database);
            const snapshot = await repository.getReplayableSnapshot({
              actorKind: context.actor.type === "apiKey" ? "API_KEY" : "USER",
              actorPrincipalId: context.actor.principalId,
              id: snapshotId,
              workspaceId: context.workspaceId,
            });
            if (!snapshot)
              throw createGraphQLError(
                "NOT_FOUND",
                "The graph snapshot was not found.",
              );
            const invalidate = async () => {
              await audit.write(database, {
                action: "graph_snapshot.invalidated",
                changedFields: ["validity"],
                metadata: { outcome: "INVALID" },
                resourceKind: "graphSnapshot",
                resourceId: snapshot.id,
              });
              return { snapshot: null, valid: false } as const;
            };
            if (!validateStoredGraphSnapshotManifest(snapshot).valid)
              return invalidate();
            try {
              if (
                !GRAPH_ANALYSIS_ALGORITHMS.includes(
                  snapshot.algorithm as GraphAnalysisAlgorithm,
                )
              )
                return invalidate();
              const algorithm = snapshot.algorithm as GraphAnalysisAlgorithm;
              const filter = normalizeFilterOrError(
                snapshot.queryInput as GraphFilterInput,
              );
              validateAnalysisCaps(filter, algorithm);
              const view = await authorizeSnapshotView(
                database,
                snapshot.graphViewId,
              );
              if (view && canonical(view.filter) !== canonical(filter))
                return invalidate();
              const graph = await buildGraph(database, filter);
              if (graph.limits.nodesTruncated || graph.limits.edgesTruncated)
                return invalidate();
              const manifest = await currentManifest(database, {
                algorithm,
                filter,
                graph,
              });
              const valid =
                validateGraphSnapshotReplay(snapshot, manifest).valid &&
                snapshot.actorPrincipalId === context.actor.principalId &&
                snapshot.actorKind ===
                  (context.actor.type === "apiKey" ? "API_KEY" : "USER") &&
                snapshot.queryHash === manifest.queryHash &&
                snapshot.authorizationHash === manifest.authorizationHash &&
                snapshot.algorithmVersion === manifest.algorithmVersion &&
                snapshot.algorithmConfigHash === manifest.algorithmConfigHash &&
                canonical(snapshot.algorithmConfiguration) ===
                  canonical(manifest.algorithmConfiguration) &&
                canonical(snapshot.runtimeContract) ===
                  canonical(manifest.runtimeContract) &&
                canonical(snapshot.includedPersonVersions) ===
                  canonical(
                    Object.fromEntries(
                      manifest.personVersions.map(({ id, version }) => [
                        id,
                        version,
                      ]),
                    ),
                  ) &&
                canonical(snapshot.includedRelationshipVersions) ===
                  canonical(
                    Object.fromEntries(
                      manifest.relationshipVersions.map(({ id, version }) => [
                        id,
                        version,
                      ]),
                    ),
                  ) &&
                canonical(snapshot.includedRelationshipTypeVersions) ===
                  canonical(
                    Object.fromEntries(
                      manifest.relationshipTypeVersions.map(
                        ({ id, version }) => [id, version],
                      ),
                    ),
                  );
              if (!valid) return invalidate();
              await audit.write(database, {
                action: "graph_snapshot.replay",
                changedFields: ["validity"],
                metadata: { outcome: "VALID" },
                resourceKind: "graphSnapshot",
                resourceId: snapshot.id,
              });
              return { snapshot, valid: true } as const;
            } catch (error) {
              const code =
                error && typeof error === "object"
                  ? (error as { extensions?: { code?: string } }).extensions
                      ?.code
                  : undefined;
              if (
                code === "NOT_FOUND" ||
                code === "VALIDATION_FAILED" ||
                code === "PRECONDITION_FAILED" ||
                (error instanceof TypeError &&
                  error.message ===
                    "The graph snapshot manifest exceeds supported bounds.")
              )
                return invalidate();
              throw error;
            }
          },
          { isolationLevel: "repeatable read" },
        );
        context.metrics.snapshotReplay({
          outcome: result.valid ? "VALID" : "INVALID",
        });
        return result;
      } catch (error) {
        const safeError = isStatementTimeout(error)
          ? createGraphQLError(
              "RATE_LIMITED",
              "The graph snapshot replay exceeded its bounded execution time.",
              { requestId: context.requestId },
            )
          : error;
        const code =
          safeError && typeof safeError === "object"
            ? (safeError as { extensions?: { code?: string } }).extensions?.code
            : undefined;
        context.metrics.snapshotReplay({
          outcome:
            code === "FORBIDDEN" ||
            code === "NOT_FOUND" ||
            code === "RATE_LIMITED"
              ? "DENIED"
              : "ERROR",
        });
        throw safeError;
      }
    },
    async runAnalysis(input: {
      filter?: GraphFilterInput | null;
      algorithm: GraphAnalysisAlgorithm;
      graphViewId?: string | null;
    }) {
      if (!GRAPH_ANALYSIS_ALGORITHMS.includes(input.algorithm))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The graph analysis algorithm is invalid.",
        );
      const requestedFilter = input.filter
        ? normalizeFilterOrError(input.filter)
        : null;
      if (!requestedFilter && !input.graphViewId)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A graph filter or saved graph view is required.",
        );
      try {
        await context.operationLimiter.consume({
          operationClass: "graph.analysis",
          cost: input.filter ? graphCost(input.filter) * 2 : 800,
          policy: ANALYSIS_POLICY,
          clientPolicy: ANALYSIS_CLIENT_POLICY,
        });
        if (requestedFilter)
          validateAnalysisCaps(requestedFilter, input.algorithm);
        const result = await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '5000ms'`,
            );
            const database = transaction as Database;
            let filter = requestedFilter;
            let graphViewId: string | null = null;
            if (input.graphViewId) {
              graphViewId = normalizeUuid(
                input.graphViewId,
                "The graph view ID is invalid.",
              );
              const view = await authorizeSnapshotView(database, graphViewId);
              if (!view)
                throw new Error("unreachable graph view authorization");
              if (
                requestedFilter &&
                canonical(requestedFilter) !== canonical(view.filter)
              )
                throw createGraphQLError(
                  "VALIDATION_FAILED",
                  "The analysis filter must match the saved graph view.",
                );
              filter = view.filter;
            }
            if (!filter) throw new Error("unreachable graph analysis filter");
            validateAnalysisCaps(filter, input.algorithm);
            const graph = await buildGraph(database, filter);
            return persistAnalysis(database, {
              graph,
              filter,
              algorithm: input.algorithm,
              graphViewId,
            });
          },
          { isolationLevel: "repeatable read" },
        );
        context.metrics.analysisRun({
          algorithm: input.algorithm,
          outcome: "SUCCESS",
        });
        return result;
      } catch (error) {
        const safeError = isStatementTimeout(error)
          ? createGraphQLError(
              "RATE_LIMITED",
              "The graph analysis exceeded its bounded execution time.",
              { requestId: context.requestId },
            )
          : error;
        const code =
          safeError && typeof safeError === "object"
            ? (safeError as { extensions?: { code?: string } }).extensions?.code
            : undefined;
        context.metrics.analysisRun({
          algorithm: input.algorithm,
          outcome:
            code === "FORBIDDEN" ||
            code === "NOT_FOUND" ||
            code === "RATE_LIMITED"
              ? "DENIED"
              : code === "VALIDATION_FAILED" || code === "PRECONDITION_FAILED"
                ? "INVALID"
                : "ERROR",
        });
        throw safeError;
      }
    },
    async rerunAnalysis(input: {
      snapshotId: string;
      algorithm: GraphAnalysisAlgorithm;
    }) {
      if (!GRAPH_ANALYSIS_ALGORITHMS.includes(input.algorithm))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The graph analysis algorithm is invalid.",
        );
      const snapshotId = normalizeUuid(
        input.snapshotId,
        "The graph snapshot ID is invalid.",
      );
      try {
        await context.operationLimiter.consume({
          operationClass: "graph.analysis",
          cost: 800,
          policy: ANALYSIS_POLICY,
          clientPolicy: ANALYSIS_CLIENT_POLICY,
        });
        const result = await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '5000ms'`,
            );
            const database = transaction as Database;
            const repository = createGraphRepository(database);
            const snapshot = await repository.getReplayableSnapshot({
              actorKind: context.actor.type === "apiKey" ? "API_KEY" : "USER",
              actorPrincipalId: context.actor.principalId,
              id: snapshotId,
              workspaceId: context.workspaceId,
            });
            if (!snapshot)
              throw createGraphQLError(
                "NOT_FOUND",
                "The graph snapshot was not found.",
              );
            if (!validateStoredGraphSnapshotManifest(snapshot).valid)
              throw createGraphQLError(
                "PRECONDITION_FAILED",
                "The graph snapshot is no longer reproducible.",
              );
            if (
              !GRAPH_ANALYSIS_ALGORITHMS.includes(
                snapshot.algorithm as GraphAnalysisAlgorithm,
              )
            )
              throw createGraphQLError(
                "PRECONDITION_FAILED",
                "The graph snapshot is no longer reproducible.",
              );
            const sourceAlgorithm =
              snapshot.algorithm as GraphAnalysisAlgorithm;
            const filter = normalizeFilterOrError(
              snapshot.queryInput as GraphFilterInput,
            );
            validateAnalysisCaps(filter, sourceAlgorithm);
            validateAnalysisCaps(filter, input.algorithm);
            let graph: GraphResult;
            try {
              const view = await authorizeSnapshotView(
                database,
                snapshot.graphViewId,
              );
              if (view && canonical(view.filter) !== canonical(filter))
                throw createGraphQLError(
                  "PRECONDITION_FAILED",
                  "The graph snapshot is no longer reproducible.",
                );
              graph = await buildGraph(database, filter);
              if (graph.limits.nodesTruncated || graph.limits.edgesTruncated)
                throw createGraphQLError(
                  "PRECONDITION_FAILED",
                  "The graph snapshot is no longer reproducible.",
                );
            } catch (error) {
              const code =
                error && typeof error === "object"
                  ? (error as { extensions?: { code?: string } }).extensions
                      ?.code
                  : undefined;
              if (code === "NOT_FOUND")
                throw createGraphQLError(
                  "PRECONDITION_FAILED",
                  "The graph snapshot is no longer reproducible.",
                );
              throw error;
            }
            const manifest = await currentManifest(database, {
              algorithm: sourceAlgorithm,
              filter,
              graph,
            });
            if (
              !validateGraphSnapshotReplay(snapshot, manifest).valid ||
              snapshot.actorPrincipalId !== context.actor.principalId ||
              snapshot.actorKind !==
                (context.actor.type === "apiKey" ? "API_KEY" : "USER") ||
              snapshot.queryHash !== manifest.queryHash ||
              snapshot.authorizationHash !== manifest.authorizationHash ||
              snapshot.algorithm !== sourceAlgorithm ||
              snapshot.algorithmVersion !== manifest.algorithmVersion ||
              snapshot.algorithmConfigHash !== manifest.algorithmConfigHash ||
              canonical(snapshot.algorithmConfiguration) !==
                canonical(manifest.algorithmConfiguration) ||
              canonical(snapshot.runtimeContract) !==
                canonical(manifest.runtimeContract) ||
              canonical(snapshot.includedPersonVersions) !==
                canonical(
                  Object.fromEntries(
                    manifest.personVersions.map(({ id, version }) => [
                      id,
                      version,
                    ]),
                  ),
                ) ||
              canonical(snapshot.includedRelationshipVersions) !==
                canonical(
                  Object.fromEntries(
                    manifest.relationshipVersions.map(({ id, version }) => [
                      id,
                      version,
                    ]),
                  ),
                ) ||
              canonical(snapshot.includedRelationshipTypeVersions) !==
                canonical(
                  Object.fromEntries(
                    manifest.relationshipTypeVersions.map(({ id, version }) => [
                      id,
                      version,
                    ]),
                  ),
                )
            ) {
              throw createGraphQLError(
                "PRECONDITION_FAILED",
                "The graph snapshot is no longer reproducible.",
              );
            }
            return persistAnalysis(database, {
              graph,
              filter,
              algorithm: input.algorithm,
              graphViewId: snapshot.graphViewId,
              sourceSnapshotId: snapshot.id,
            });
          },
          { isolationLevel: "repeatable read" },
        );
        context.metrics.analysisRun({
          algorithm: input.algorithm,
          outcome: "SUCCESS",
        });
        return result;
      } catch (error) {
        const safeError = isStatementTimeout(error)
          ? createGraphQLError(
              "RATE_LIMITED",
              "The graph analysis exceeded its bounded execution time.",
              { requestId: context.requestId },
            )
          : error;
        const code =
          safeError && typeof safeError === "object"
            ? (safeError as { extensions?: { code?: string } }).extensions?.code
            : undefined;
        context.metrics.analysisRun({
          algorithm: input.algorithm,
          outcome:
            code === "FORBIDDEN" ||
            code === "NOT_FOUND" ||
            code === "RATE_LIMITED"
              ? "DENIED"
              : code === "VALIDATION_FAILED" || code === "PRECONDITION_FAILED"
                ? "INVALID"
                : "ERROR",
        });
        throw safeError;
      }
    },
    async getAnalysisRun(id: string) {
      const runId = normalizeUuid(id, "The graph analysis run ID is invalid.");
      await context.operationLimiter.consume({
        clientPolicy: ANALYSIS_READ_CLIENT_POLICY,
        operationClass: ANALYSIS_READ_OPERATION_CLASS,
        cost: analysisRunReadCost(),
        policy: ANALYSIS_READ_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const repository = createGraphRepository(transaction as Database);
            const run = await repository.getAuthorizedAnalysisRun({
              workspaceId: context.workspaceId,
              id: runId,
              actorId: context.actor.type === "user" ? context.actor.id : null,
              personVisibility,
              relationshipVisibility,
            });
            if (!run)
              throw createGraphQLError(
                "NOT_FOUND",
                "The graph analysis run was not found.",
              );
            return run;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The graph analysis query exceeded its bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async listAnalysisRuns(input: {
      first?: number | null;
      after?: string | null;
    }): Promise<AnalysisRunConnection> {
      const page = normalizePagination(input);
      const afterId = decodeAnalysisRunCursor(
        page.after,
        context.workspaceId,
        context.cursorHmacKey,
      );
      await context.operationLimiter.consume({
        clientPolicy: ANALYSIS_READ_CLIENT_POLICY,
        operationClass: ANALYSIS_READ_OPERATION_CLASS,
        cost: analysisRunListReadCost(page.first),
        policy: ANALYSIS_READ_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const repository = createGraphRepository(transaction as Database);
            const rows = await repository.listAnalysisRuns({
              workspaceId: context.workspaceId,
              actorId: context.actor.type === "user" ? context.actor.id : null,
              afterId,
              personVisibility,
              relationshipVisibility,
              limit: page.first + 1,
            });
            const nodes = rows.slice(0, page.first);
            const last = nodes.at(-1);
            return {
              nodes,
              pageInfo: {
                endCursor: last
                  ? encodeAnalysisRunCursor(
                      last,
                      context.workspaceId,
                      context.cursorHmacKey,
                    )
                  : null,
                hasNextPage: rows.length > page.first,
              },
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The graph analysis query exceeded its bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async getAnalysisResults(input: {
      runId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<AnalysisResultConnection> {
      const runId = normalizeUuid(
        input.runId,
        "The graph analysis run ID is invalid.",
      );
      const page = normalizePagination(input);
      const after = decodeAnalysisResultCursor(
        page.after,
        runId,
        context.workspaceId,
        context.cursorHmacKey,
      );
      await context.operationLimiter.consume({
        clientPolicy: ANALYSIS_READ_CLIENT_POLICY,
        operationClass: ANALYSIS_READ_OPERATION_CLASS,
        cost: analysisResultReadCost(page.first),
        policy: ANALYSIS_READ_POLICY,
      });
      try {
        return await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '2500ms'`,
            );
            const repository = createGraphRepository(transaction as Database);
            const run = await repository.getAuthorizedAnalysisRun({
              workspaceId: context.workspaceId,
              id: runId,
              actorId: context.actor.type === "user" ? context.actor.id : null,
              personVisibility,
              relationshipVisibility,
            });
            if (!run)
              throw createGraphQLError(
                "NOT_FOUND",
                "The graph analysis run was not found.",
              );
            const rows = await repository.getAnalysisResults({
              workspaceId: context.workspaceId,
              runId: run.id,
              after,
              personVisibility,
              limit: page.first + 1,
            });
            verifyAnalysisResults(rows, run.algorithmVersion);
            const nodes = rows.slice(0, page.first);
            const last = nodes.at(-1);
            return {
              nodes,
              pageInfo: {
                endCursor: last
                  ? encodeAnalysisResultCursor(
                      last,
                      run.id,
                      context.workspaceId,
                      context.cursorHmacKey,
                    )
                  : null,
                hasNextPage: rows.length > page.first,
              },
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "RATE_LIMITED",
            "The graph analysis result query exceeded its bounded execution time.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
    async exportAnalysisResults(input: {
      format: "JSON" | "CSV";
      first?: number | null;
      runId: string;
    }) {
      const runId = normalizeUuid(
        input.runId,
        "The graph analysis run ID is invalid.",
      );
      if (input.format !== "JSON" && input.format !== "CSV")
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The graph analysis export format is invalid.",
        );
      const first = input.first ?? ANALYSIS_EXPORT_LIMIT;
      if (
        !Number.isInteger(first) ||
        first < 1 ||
        first > ANALYSIS_EXPORT_LIMIT
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          `first must be between 1 and ${ANALYSIS_EXPORT_LIMIT}.`,
        );
      try {
        await context.operationLimiter.consume({
          clientPolicy: ANALYSIS_CLIENT_POLICY,
          operationClass: "graph.analysis.export",
          cost: 200 + first,
          policy: ANALYSIS_POLICY,
        });
        const result = await context.database.transaction(
          async (transaction) => {
            await transaction.execute(
              sql`set local statement_timeout = '5000ms'`,
            );
            const database = transaction as Database;
            const repository = createGraphRepository(database);
            const run = await repository.getAuthorizedAnalysisRun({
              actorId: context.actor.type === "user" ? context.actor.id : null,
              id: runId,
              personVisibility,
              relationshipVisibility,
              workspaceId: context.workspaceId,
            });
            if (!run)
              throw createGraphQLError(
                "NOT_FOUND",
                "The graph analysis run was not found.",
              );
            const rows = await repository.getAnalysisResults({
              after: null,
              limit: first + 1,
              personVisibility,
              runId,
              workspaceId: context.workspaceId,
            });
            verifyAnalysisResults(rows, run.algorithmVersion);
            const values = rows.slice(0, first);
            const truncated = rows.length > first;
            const content =
              input.format === "JSON"
                ? serializeAnalysisResultsJson({
                    algorithm: run.algorithm,
                    algorithmVersion: run.algorithmVersion,
                    configurationHash: run.configurationHash,
                    results: values,
                    truncated,
                  })
                : serializeAnalysisResultsCsv(values);
            await audit.write(database, {
              action: "graph_analysis.export",
              changedFields: ["format", "resultCount"],
              metadata: {
                format: input.format,
                resultCount: values.length,
                truncated,
              },
              resourceKind: "analysisRun",
              resourceId: run.id,
            });
            return {
              content,
              contentType:
                input.format === "JSON"
                  ? "application/json; charset=utf-8"
                  : "text/csv; charset=utf-8",
              filename: `graph-analysis-${run.id}.${
                input.format === "JSON" ? "json" : "csv"
              }`,
              format: input.format,
              resultCount: values.length,
              truncated,
            };
          },
          { isolationLevel: "repeatable read" },
        );
        context.metrics.analysisExport({
          format: input.format,
          outcome: "SUCCESS",
        });
        return result;
      } catch (error) {
        const code =
          error && typeof error === "object"
            ? (error as { extensions?: { code?: string } }).extensions?.code
            : undefined;
        context.metrics.analysisExport({
          format: input.format,
          outcome:
            code === "FORBIDDEN" ||
            code === "NOT_FOUND" ||
            code === "RATE_LIMITED"
              ? "DENIED"
              : code === "VALIDATION_FAILED"
                ? "INVALID"
                : "ERROR",
        });
        if (isStatementTimeout(error))
          throw createGraphQLError(
            "PROVIDER_UNAVAILABLE",
            "A required provider is unavailable.",
            { requestId: context.requestId },
          );
        throw error;
      }
    },
  };
}

export type GraphService = ReturnType<typeof createGraphService>;
