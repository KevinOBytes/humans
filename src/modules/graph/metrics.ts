import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import pagerank from "graphology-metrics/centrality/pagerank";

import { toGraphologyGraph } from "./transform";
import type { GraphResult } from "./types";

export const GRAPH_ANALYSIS_ALGORITHMS = [
  "DEGREE",
  "PAGERANK",
  "LOUVAIN_COMMUNITY",
] as const;
export type GraphAnalysisAlgorithm = (typeof GRAPH_ANALYSIS_ALGORITHMS)[number];

export const GRAPH_ANALYSIS_CONFIGURATIONS = Object.freeze({
  DEGREE: Object.freeze({
    projection: "authorized-visible-incidence-v1",
  }),
  PAGERANK: Object.freeze({
    alpha: 0.85,
    maxIterations: 100,
    projection: "authorized-directed-aggregate-count-v1",
    tolerance: 1e-8,
    weight: "relationship-count",
  }),
  LOUVAIN_COMMUNITY: Object.freeze({
    fastLocalMoves: true,
    projection: "authorized-undirected-aggregate-count-v1",
    randomWalk: true,
    resolution: 1,
    seed: "graph-fingerprint-fnv1a32-v1",
    weight: "relationship-count",
  }),
} satisfies Readonly<
  Record<GraphAnalysisAlgorithm, Readonly<Record<string, unknown>>>
>);

export function graphAnalysisConfiguration(
  algorithm: GraphAnalysisAlgorithm,
): Readonly<Record<string, unknown>> {
  return GRAPH_ANALYSIS_CONFIGURATIONS[algorithm];
}

export type GraphMetric = {
  personId: string;
  metricKey: "degree" | "pagerank" | "community";
  value: number;
  rank: number;
  algorithmVersion: string;
  explanation: string;
};

export const GRAPH_ANALYSIS_CONTRACTS = {
  DEGREE: {
    nodes: 10_000,
    edges: 25_000,
    key: "degree",
    version: "graphology@0.26.0/degree/humans-v1",
    explanation:
      "Visible relationship incidence count in this authorized snapshot.",
  },
  PAGERANK: {
    nodes: 2_000,
    edges: 10_000,
    key: "pagerank",
    version: "graphology-metrics@2.4.0/pagerank/humans-v1",
    explanation:
      "PageRank over this authorized snapshot using relationship direction, alpha 0.85, tolerance 1e-8, and at most 100 iterations.",
  },
  LOUVAIN_COMMUNITY: {
    nodes: 2_000,
    edges: 10_000,
    key: "community",
    version: "graphology-communities-louvain@2.0.2/humans-undirected-v1",
    explanation:
      "Community label in a seeded undirected simple projection; parallel visible relationships are aggregated by count.",
  },
} as const;

export function graphAnalysisCapViolation(
  nodeLimit: number,
  edgeLimit: number,
  algorithm: GraphAnalysisAlgorithm,
): string | null {
  const contract = GRAPH_ANALYSIS_CONTRACTS[algorithm];
  return nodeLimit > contract.nodes || edgeLimit > contract.edges
    ? `${algorithm} accepts at most ${contract.nodes.toLocaleString("en-US")} nodes/${contract.edges.toLocaleString("en-US")} edges`
    : null;
}

function assertWithinCaps(
  result: GraphResult,
  algorithm: GraphAnalysisAlgorithm,
) {
  const contract = GRAPH_ANALYSIS_CONTRACTS[algorithm];
  const nodeCount = Math.max(
    result.nodes.length,
    result.limits.returnedNodeCount,
  );
  const edgeCount = Math.max(
    result.edges.length,
    result.limits.returnedEdgeCount,
  );
  if (nodeCount > contract.nodes || edgeCount > contract.edges) {
    throw new Error(
      graphAnalysisCapViolation(nodeCount, edgeCount, algorithm)!,
    );
  }
}

function ranked(values: Record<string, number>) {
  return new Map(
    Object.entries(values)
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .map(([id], index) => [id, index + 1]),
  );
}

function seededRng(seedText: string) {
  let state = 2_166_136_261;
  for (const character of seedText) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619);
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function addAggregatedEdge(
  weights: Map<string, number>,
  source: string,
  target: string,
) {
  const key = `${source}\u0000${target}`;
  weights.set(key, (weights.get(key) ?? 0) + 1);
}

function pagerankGraph(result: GraphResult) {
  const graph = new Graph({
    type: "directed",
    multi: false,
    allowSelfLoops: true,
  });
  for (const node of [...result.nodes].sort((left, right) =>
    left.id.localeCompare(right.id),
  ))
    graph.addNode(node.id);
  const weights = new Map<string, number>();
  for (const edge of [...result.edges].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    addAggregatedEdge(weights, edge.source, edge.target);
    if (!edge.directed && edge.source !== edge.target)
      addAggregatedEdge(weights, edge.target, edge.source);
  }
  for (const [key, weight] of [...weights].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const [source, target] = key.split("\u0000");
    if (source && target) graph.addDirectedEdge(source, target, { weight });
  }
  return graph;
}

function louvainGraph(result: GraphResult) {
  const graph = new Graph({
    type: "undirected",
    multi: false,
    allowSelfLoops: true,
  });
  for (const node of [...result.nodes].sort((left, right) =>
    left.id.localeCompare(right.id),
  ))
    graph.addNode(node.id);
  const weights = new Map<string, number>();
  for (const edge of [...result.edges].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const [source, target] =
      edge.source < edge.target
        ? [edge.source, edge.target]
        : [edge.target, edge.source];
    addAggregatedEdge(weights, source, target);
  }
  for (const [key, weight] of [...weights].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const [source, target] = key.split("\u0000");
    if (source && target) graph.addUndirectedEdge(source, target, { weight });
  }
  return graph;
}

export function calculateGraphMetrics(
  result: GraphResult,
  algorithm: GraphAnalysisAlgorithm,
  configuration = graphAnalysisConfiguration(algorithm),
): GraphMetric[] {
  assertWithinCaps(result, algorithm);
  if (configuration !== GRAPH_ANALYSIS_CONFIGURATIONS[algorithm])
    throw new TypeError("The graph analysis configuration is invalid.");
  const contract = GRAPH_ANALYSIS_CONTRACTS[algorithm];
  let values: Record<string, number>;

  if (algorithm === "DEGREE") {
    const graph = toGraphologyGraph(result);
    values = Object.fromEntries(
      [...graph.nodes()].sort().map((id) => [id, graph.degree(id)]),
    );
  } else if (algorithm === "PAGERANK") {
    const config = GRAPH_ANALYSIS_CONFIGURATIONS.PAGERANK;
    values = pagerank(pagerankGraph(result), {
      getEdgeWeight: "weight",
      alpha: config.alpha,
      maxIterations: config.maxIterations,
      tolerance: config.tolerance,
    });
  } else {
    const config = GRAPH_ANALYSIS_CONFIGURATIONS.LOUVAIN_COMMUNITY;
    const raw = louvain(louvainGraph(result), {
      getEdgeWeight: "weight",
      resolution: config.resolution,
      rng: seededRng(result.fingerprint),
      randomWalk: config.randomWalk,
      fastLocalMoves: config.fastLocalMoves,
    });
    const members = new Map<number, string[]>();
    for (const [personId, community] of Object.entries(raw))
      members.set(
        community,
        [...(members.get(community) ?? []), personId].sort(),
      );
    const normalized = new Map(
      [...members]
        .sort((left, right) =>
          (left[1][0] ?? "").localeCompare(right[1][0] ?? ""),
        )
        .map(([community], index) => [community, index + 1]),
    );
    values = Object.fromEntries(
      Object.entries(raw).map(([personId, community]) => [
        personId,
        normalized.get(community) ?? 0,
      ]),
    );
  }

  const ranks = ranked(values);
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([personId, value]) => ({
      personId,
      metricKey: contract.key,
      value,
      rank: ranks.get(personId) ?? 1,
      algorithmVersion: contract.version,
      explanation: contract.explanation,
    }));
}
