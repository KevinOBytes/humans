import type {
  GraphFilterInput,
  GraphPageQuery,
  GraphSavedViewPageQuery,
} from "@/graphql/generated/graphql";
import type {
  GraphPosition,
  GraphRelationshipState,
  GraphSensitivity,
  GraphResult,
  GraphTraversalMode,
} from "@/modules/graph/types";

export function savedViewGraphFilter(
  view: NonNullable<GraphSavedViewPageQuery["graphView"]>,
): GraphFilterInput {
  const filter = required(view.filter, "graphView.filter");
  return {
    mode: required(filter.mode, "graphView.filter.mode"),
    rootPersonIds: required(
      filter.rootPersonIds,
      "graphView.filter.rootPersonIds",
    ),
    depth: required(filter.depth, "graphView.filter.depth"),
    relationshipTypeIds: required(
      filter.relationshipTypeIds,
      "graphView.filter.relationshipTypeIds",
    ),
    relationshipStates: required(
      filter.relationshipStates,
      "graphView.filter.relationshipStates",
    ),
    sensitivities: required(
      filter.sensitivities,
      "graphView.filter.sensitivities",
    ),
    minimumConfidence: filter.minimumConfidence ?? undefined,
    at: filter.at ?? undefined,
    from: filter.from ?? undefined,
    until: filter.until ?? undefined,
    nodeLimit: required(filter.nodeLimit, "graphView.filter.nodeLimit"),
    edgeLimit: required(filter.edgeLimit, "graphView.filter.edgeLimit"),
    includeIsolates: required(
      filter.includeIsolates,
      "graphView.filter.includeIsolates",
    ),
  };
}

export function savedViewPositions(
  view: NonNullable<GraphSavedViewPageQuery["graphView"]>,
): GraphPosition[] {
  return required(
    required(view.positions, "graphView.positions").nodes,
    "graphView.positions.nodes",
  )
    .map((position) => {
      const mapped = {
        id: required(position.id, "graphView.positions.id"),
        x: required(position.x, "graphView.positions.x"),
        y: required(position.y, "graphView.positions.y"),
      };
      if (
        !Number.isFinite(mapped.x) ||
        !Number.isFinite(mapped.y) ||
        Math.abs(mapped.x) > 1_000_000 ||
        Math.abs(mapped.y) > 1_000_000
      ) {
        throw new Error("The saved graph view contained an invalid position.");
      }
      return mapped;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new Error(`The graph response omitted ${field}.`);
  }
  return value;
}

function sensitivity(value: string | null | undefined): GraphSensitivity {
  const normalized = required(value, "sensitivity").toLowerCase();
  if (
    normalized !== "public" &&
    normalized !== "internal" &&
    normalized !== "confidential" &&
    normalized !== "restricted"
  ) {
    throw new Error("The graph response contained an unsupported sensitivity.");
  }
  return normalized;
}

function relationshipState(
  value: string | null | undefined,
): GraphRelationshipState {
  const normalized = required(value, "relationshipState").toLowerCase();
  if (
    normalized !== "asserted" &&
    normalized !== "inferred" &&
    normalized !== "corroborated" &&
    normalized !== "disputed" &&
    normalized !== "disproven" &&
    normalized !== "inactive"
  ) {
    throw new Error(
      "The graph response contained an unsupported relationship state.",
    );
  }
  return normalized;
}

export function graphPageResult(
  graph: NonNullable<GraphPageQuery["graph"]>,
): GraphResult {
  const filter = required(graph.normalizedFilter, "normalizedFilter");
  const limits = required(graph.limits, "limits");
  const mode = required(filter.mode, "normalizedFilter.mode");
  if (mode !== "WORKSPACE" && mode !== "NEIGHBORHOOD") {
    throw new Error(
      "The graph response contained an unsupported traversal mode.",
    );
  }
  return {
    fingerprint: required(graph.fingerprint, "fingerprint"),
    generatedAt: required(graph.generatedAt, "generatedAt"),
    normalizedFilter: {
      mode: mode as GraphTraversalMode,
      rootPersonIds: required(filter.rootPersonIds, "rootPersonIds"),
      depth: required(filter.depth, "depth"),
      relationshipTypeIds: required(
        filter.relationshipTypeIds,
        "relationshipTypeIds",
      ),
      relationshipStates: required(
        filter.relationshipStates,
        "relationshipStates",
      ).map(relationshipState),
      sensitivities: required(filter.sensitivities, "sensitivities").map(
        sensitivity,
      ),
      minimumConfidence: filter.minimumConfidence ?? null,
      at: filter.at ?? null,
      from: filter.from ?? null,
      until: filter.until ?? null,
      nodeLimit: required(filter.nodeLimit, "nodeLimit"),
      edgeLimit: required(filter.edgeLimit, "edgeLimit"),
      includeIsolates: required(filter.includeIsolates, "includeIsolates"),
    },
    limits: {
      requestedNodeLimit: required(
        limits.requestedNodeLimit,
        "requestedNodeLimit",
      ),
      requestedEdgeLimit: required(
        limits.requestedEdgeLimit,
        "requestedEdgeLimit",
      ),
      returnedNodeCount: required(
        limits.returnedNodeCount,
        "returnedNodeCount",
      ),
      returnedEdgeCount: required(
        limits.returnedEdgeCount,
        "returnedEdgeCount",
      ),
      nodesTruncated: required(limits.nodesTruncated, "nodesTruncated"),
      edgesTruncated: required(limits.edgesTruncated, "edgesTruncated"),
      reasons: required(limits.reasons, "reasons"),
    },
    nodes: required(graph.nodes, "nodes").map((node) => ({
      id: required(node.id, "node.id"),
      displayName: required(node.displayName, "node.displayName"),
      sortName: node.sortName ?? null,
      status: required(node.status, "node.status"),
      sensitivity: sensitivity(node.sensitivity),
      version: required(node.version, "node.version"),
    })),
    edges: required(graph.edges, "edges").map((edge) => ({
      id: required(edge.id, "edge.id"),
      relationshipId: required(edge.relationshipId, "edge.relationshipId"),
      source: required(edge.source, "edge.source"),
      target: required(edge.target, "edge.target"),
      relationshipTypeId: required(
        edge.relationshipTypeId,
        "edge.relationshipTypeId",
      ),
      forwardLabel: required(edge.forwardLabel, "edge.forwardLabel"),
      inverseLabel: required(edge.inverseLabel, "edge.inverseLabel"),
      directed: required(edge.directed, "edge.directed"),
      state: relationshipState(edge.state),
      sensitivity: sensitivity(edge.sensitivity),
      confidence: required(edge.confidence, "edge.confidence"),
      strength: edge.strength ?? null,
      temporalSemantics: required(
        edge.temporalSemantics,
        "edge.temporalSemantics",
      ),
      temporalPrecision: required(
        edge.temporalPrecision,
        "edge.temporalPrecision",
      ),
      validFrom: edge.validFrom ?? null,
      validUntil: edge.validUntil ?? null,
      version: required(edge.version, "edge.version"),
    })),
  };
}
