export const GRAPH_SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export const GRAPH_RELATIONSHIP_STATES = [
  "asserted",
  "inferred",
  "corroborated",
  "disputed",
  "disproven",
  "inactive",
] as const;
export const GRAPH_FINGERPRINT_VERSION = "humans.graph-fingerprint.v1";

export type GraphSensitivity = (typeof GRAPH_SENSITIVITIES)[number];
export type GraphRelationshipState = (typeof GRAPH_RELATIONSHIP_STATES)[number];
export type GraphTraversalMode = "WORKSPACE" | "NEIGHBORHOOD";

export type GraphNode = {
  id: string;
  displayName: string;
  sortName: string | null;
  status: string;
  sensitivity: GraphSensitivity;
  version: number;
};

export type GraphEdge = {
  id: string;
  relationshipId: string;
  source: string;
  target: string;
  relationshipTypeId: string;
  relationshipTypeVersion?: number;
  forwardLabel: string;
  inverseLabel: string;
  directed: boolean;
  state: GraphRelationshipState;
  sensitivity: GraphSensitivity;
  confidence: number;
  strength: number | null;
  temporalSemantics: string;
  temporalPrecision: string;
  validFrom: string | null;
  validUntil: string | null;
  version: number;
};

export type NormalizedGraphFilter = {
  mode: GraphTraversalMode;
  rootPersonIds: string[];
  depth: number;
  relationshipTypeIds: string[];
  relationshipStates: GraphRelationshipState[];
  sensitivities: GraphSensitivity[];
  minimumConfidence: number | null;
  at: string | null;
  from: string | null;
  until: string | null;
  nodeLimit: number;
  edgeLimit: number;
  includeIsolates: boolean;
};

export type GraphLimits = {
  requestedNodeLimit: number;
  requestedEdgeLimit: number;
  returnedNodeCount: number;
  returnedEdgeCount: number;
  nodesTruncated: boolean;
  edgesTruncated: boolean;
  reasons: string[];
};

export type GraphResult = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  normalizedFilter: NormalizedGraphFilter;
  limits: GraphLimits;
  fingerprint: string;
  generatedAt: string;
};

export type GraphPosition = { id: string; x: number; y: number };
