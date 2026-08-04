import Graph from "graphology";
import { bidirectional } from "graphology-shortest-path";

import {
  GRAPH_RELATIONSHIP_STATES,
  GRAPH_SENSITIVITIES,
  type GraphPosition,
  type GraphResult,
  type NormalizedGraphFilter,
} from "./types";

export type GraphFilterInput = {
  mode: NormalizedGraphFilter["mode"];
  rootPersonIds?: string[] | null;
  depth?: number | null;
  relationshipTypeIds?: string[] | null;
  relationshipStates?: string[] | null;
  sensitivities?: NormalizedGraphFilter["sensitivities"] | null;
  minimumConfidence?: number | null;
  at?: string | null;
  from?: string | null;
  until?: string | null;
  nodeLimit?: number | null;
  edgeLimit?: number | null;
  includeIsolates?: boolean | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uniqueSorted(
  values: readonly string[] | null | undefined,
  name: string,
  maximum: number,
) {
  const result = [
    ...new Set((values ?? []).map((value) => value.toLowerCase())),
  ].sort();
  if (result.length > maximum)
    throw new Error(`${name} exceeds its maximum of ${maximum}`);
  if (result.some((value) => !UUID_PATTERN.test(value)))
    throw new Error(`${name} must contain UUIDs`);
  return result;
}

function boundedInteger(
  value: number | null | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return result;
}

function canonicalInstant(value: string | null | undefined, name: string) {
  if (value === null || value === undefined) return null;
  const instant = new Date(value);
  if (!Number.isFinite(instant.valueOf()))
    throw new Error(`${name} must be a valid instant`);
  return instant.toISOString();
}

export function normalizeGraphFilter(
  input: GraphFilterInput,
): NormalizedGraphFilter {
  if (input.mode !== "WORKSPACE" && input.mode !== "NEIGHBORHOOD") {
    throw new Error("mode must be WORKSPACE or NEIGHBORHOOD");
  }

  const rootPersonIds = uniqueSorted(input.rootPersonIds, "rootPersonIds", 20);
  const relationshipTypeIds = uniqueSorted(
    input.relationshipTypeIds,
    "relationshipTypeIds",
    50,
  );
  const relationshipStates = [
    ...new Set(
      (input.relationshipStates ?? []).map((state) => state.toLowerCase()),
    ),
  ].sort();
  if (
    relationshipStates.length > 10 ||
    relationshipStates.some(
      (state) =>
        !GRAPH_RELATIONSHIP_STATES.includes(
          state as (typeof GRAPH_RELATIONSHIP_STATES)[number],
        ),
    )
  ) {
    throw new Error("relationshipStates contains an invalid state");
  }

  const sensitivities = [...new Set(input.sensitivities ?? [])].sort();
  if (
    sensitivities.length > GRAPH_SENSITIVITIES.length ||
    sensitivities.some((value) => !GRAPH_SENSITIVITIES.includes(value))
  ) {
    throw new Error("sensitivities contains an unsupported value");
  }

  const at = canonicalInstant(input.at, "at");
  const from = canonicalInstant(input.from, "from");
  const until = canonicalInstant(input.until, "until");
  if (at && (from || until))
    throw new Error("temporal at cannot be combined with from or until");
  if (from && until && from > until)
    throw new Error("temporal from must not be after until");

  const minimumConfidence = input.minimumConfidence ?? null;
  if (
    minimumConfidence !== null &&
    (!Number.isFinite(minimumConfidence) ||
      minimumConfidence < 0 ||
      minimumConfidence > 1 ||
      Math.round(minimumConfidence * 1000) !== minimumConfidence * 1000)
  ) {
    throw new Error(
      "minimumConfidence must be between 0 and 1 with at most three decimal places",
    );
  }

  const neighborhood = input.mode === "NEIGHBORHOOD";
  if (neighborhood && rootPersonIds.length === 0)
    throw new Error("NEIGHBORHOOD mode requires at least one root person");
  if (!neighborhood && rootPersonIds.length > 0)
    throw new Error("WORKSPACE mode does not accept root people");
  if (neighborhood && input.includeIsolates === true)
    throw new Error("includeIsolates is available only in WORKSPACE mode");

  const depth = boundedInteger(
    input.depth,
    neighborhood ? 1 : 0,
    0,
    neighborhood ? 4 : 0,
    "depth",
  );

  return {
    mode: input.mode,
    rootPersonIds,
    depth,
    relationshipTypeIds,
    relationshipStates:
      relationshipStates as NormalizedGraphFilter["relationshipStates"],
    sensitivities,
    minimumConfidence,
    at,
    from,
    until,
    nodeLimit: boundedInteger(input.nodeLimit, 1000, 1, 10_000, "nodeLimit"),
    edgeLimit: boundedInteger(input.edgeLimit, 4000, 0, 25_000, "edgeLimit"),
    includeIsolates: input.includeIsolates ?? false,
  };
}

export function deterministicCirclePositions(
  ids: readonly string[],
): GraphPosition[] {
  const sorted = [...new Set(ids)].sort();
  return sorted.map((id, index) => {
    const angle =
      sorted.length === 1 ? 0 : (index * Math.PI * 2) / sorted.length;
    return { id, x: Math.cos(angle), y: Math.sin(angle) };
  });
}

export function toGraphologyGraph(
  result: GraphResult,
  positions?: readonly GraphPosition[],
): Graph {
  const graph = new Graph({ multi: true, type: "mixed", allowSelfLoops: true });
  const positionMap = new Map(
    deterministicCirclePositions(result.nodes.map(({ id }) => id)).map(
      (position) => [position.id, position],
    ),
  );
  for (const position of positions ?? []) {
    if (
      positionMap.has(position.id) &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y) &&
      Math.abs(position.x) <= 1_000_000 &&
      Math.abs(position.y) <= 1_000_000
    )
      positionMap.set(position.id, position);
  }

  for (const node of [...result.nodes].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const position = positionMap.get(node.id) ?? { x: 1, y: 0 };
    graph.addNode(node.id, {
      ...node,
      x: position.x,
      y: position.y,
      label: node.displayName,
    });
  }
  for (const edge of [...result.edges].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const attributes = {
      ...edge,
      label: edge.forwardLabel,
      relationshipId: edge.relationshipId,
    };
    if (edge.directed)
      graph.addDirectedEdgeWithKey(
        edge.id,
        edge.source,
        edge.target,
        attributes,
      );
    else
      graph.addUndirectedEdgeWithKey(
        edge.id,
        edge.source,
        edge.target,
        attributes,
      );
  }
  return graph;
}

export function shortestGraphPath(
  result: GraphResult,
  source: string,
  target: string,
  mode: "NATURAL" | "UNDIRECTED",
): { nodes: string[]; edges: string[] } | null {
  const nodeIds = new Set(result.nodes.map(({ id }) => id));
  if (!nodeIds.has(source) || !nodeIds.has(target)) return null;
  const graph =
    mode === "NATURAL"
      ? toGraphologyGraph(result)
      : (() => {
          const undirected = new Graph({
            type: "undirected",
            multi: true,
            allowSelfLoops: true,
          });
          for (const node of [...result.nodes].sort((left, right) =>
            left.id.localeCompare(right.id),
          ))
            undirected.addNode(node.id);
          for (const edge of [...result.edges].sort((left, right) =>
            left.id.localeCompare(right.id),
          ))
            undirected.addUndirectedEdgeWithKey(
              edge.id,
              edge.source,
              edge.target,
            );
          return undirected;
        })();
  const nodes = bidirectional(graph, source, target);
  if (!nodes) return null;
  const sortedEdges = [...result.edges].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const edges: string[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    const edge = sortedEdges.find(
      (candidate) =>
        (candidate.source === from && candidate.target === to) ||
        ((!candidate.directed || mode === "UNDIRECTED") &&
          candidate.source === to &&
          candidate.target === from),
    );
    if (!edge) return null;
    edges.push(edge.id);
  }
  return { nodes, edges };
}

export function toRelationshipEditorGraph(
  result: GraphResult,
  focusId: string,
): {
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    data: { label: string };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    markerEnd?: { type: "arrowclosed" };
  }>;
  truncated: boolean;
} {
  const incidentEdges = result.edges
    .filter((edge) => edge.source === focusId || edge.target === focusId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const allNodeIds = new Set([focusId]);
  for (const edge of incidentEdges) {
    allNodeIds.add(edge.source);
    allNodeIds.add(edge.target);
  }
  const nodeIds = [...allNodeIds].sort().slice(0, 100);
  const allowed = new Set(nodeIds);
  const edges = incidentEdges
    .filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
    .slice(0, 250);
  const positions = new Map(
    deterministicCirclePositions(nodeIds).map(({ id, x, y }) => [
      id,
      { x: x * 240, y: y * 240 },
    ]),
  );
  const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
  return {
    nodes: nodeIds.flatMap((id) => {
      const node = nodesById.get(id);
      return node
        ? [
            {
              id,
              position: positions.get(id) ?? { x: 0, y: 0 },
              data: { label: node.displayName },
            },
          ]
        : [];
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.forwardLabel,
      ...(edge.directed ? { markerEnd: { type: "arrowclosed" as const } } : {}),
    })),
    truncated: allNodeIds.size > 100 || incidentEdges.length > 250,
  };
}
