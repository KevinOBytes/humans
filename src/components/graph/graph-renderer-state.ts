import { inferSettings } from "graphology-layout-forceatlas2";

export const MOTION_DETAIL_NODE_LIMIT = 100;
export const INITIAL_PREVIEW_NODE_LIMIT = 100;
export const INITIAL_PREVIEW_EDGE_LIMIT = 50;

export function initialPreviewNodeIds({
  nodeIds,
  edges,
}: {
  nodeIds: readonly string[];
  edges: ReadonlyArray<{ id: string; source: string; target: string }>;
}): Set<string> {
  const sortedNodeIds = [...new Set(nodeIds)].sort();
  const knownNodeIds = new Set(sortedNodeIds);
  const preview = new Set<string>();
  let includedEdges = 0;
  for (const edge of [...edges].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (includedEdges >= INITIAL_PREVIEW_EDGE_LIMIT) break;
    if (!knownNodeIds.has(edge.source) || !knownNodeIds.has(edge.target)) {
      continue;
    }
    const additionalNodes =
      Number(!preview.has(edge.source)) + Number(!preview.has(edge.target));
    if (preview.size + additionalNodes > INITIAL_PREVIEW_NODE_LIMIT) continue;
    preview.add(edge.source);
    preview.add(edge.target);
    includedEdges += 1;
  }

  for (const id of motionDetailNodeIds({
    nodeIds: sortedNodeIds,
    pathNodeIds: new Set(),
  })) {
    if (preview.size >= INITIAL_PREVIEW_NODE_LIMIT) break;
    preview.add(id);
  }
  for (const id of sortedNodeIds) {
    if (preview.size >= INITIAL_PREVIEW_NODE_LIMIT) break;
    preview.add(id);
  }
  return preview;
}

export function motionDetailNodeIds({
  nodeIds,
  pathNodeIds,
  selectedNodeId,
}: {
  nodeIds: readonly string[];
  pathNodeIds: ReadonlySet<string>;
  selectedNodeId?: string;
}): Set<string> {
  const sorted = [...new Set(nodeIds)].sort();
  const sampleSize = Math.min(sorted.length, MOTION_DETAIL_NODE_LIMIT);
  const ids = new Set(
    Array.from(
      { length: sampleSize },
      (_, index) => sorted[Math.floor((index * sorted.length) / sampleSize)]!,
    ),
  );
  for (const id of [...pathNodeIds].sort()) ids.add(id);
  if (selectedNodeId) ids.add(selectedNodeId);
  return ids;
}

export function shouldHideGraphNode({
  inMotionDetail,
  largeMotionGraph,
  motionDetailActive,
  visible,
}: {
  inMotionDetail: boolean;
  largeMotionGraph: boolean;
  motionDetailActive: boolean;
  visible: boolean;
}): boolean {
  return (
    !visible || (motionDetailActive && largeMotionGraph && !inMotionDetail)
  );
}

export function shouldHideGraphEdge({
  largeMotionGraph,
  motionDetailActive,
  visible,
}: {
  largeMotionGraph: boolean;
  motionDetailActive: boolean;
  visible: boolean;
}): boolean {
  return !visible || (motionDetailActive && largeMotionGraph);
}

export function forceAtlasParameters(nodeCount: number) {
  const inferred = inferSettings(Math.max(1, nodeCount));
  return {
    getEdgeWeight: (_edge: string, attributes: { strength?: number | null }) =>
      typeof attributes.strength === "number" &&
      Number.isFinite(attributes.strength)
        ? Math.max(0.1, attributes.strength)
        : 1,
    settings: {
      ...inferred,
      barnesHutOptimize: nodeCount >= 1_000,
      barnesHutTheta: 0.6,
      slowDown: Math.min(10, Math.max(1, inferred.slowDown ?? 1)),
    },
  };
}

export function shouldRunAnimatedLayout(
  matchMedia: ((query: string) => Pick<MediaQueryList, "matches">) | undefined,
): boolean {
  return !matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
