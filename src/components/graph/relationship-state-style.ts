import type { GraphRelationshipState } from "@/modules/graph/types";

// Text labels accompany color in tables, inspectors and the editor.
export const relationshipStateStyle: Record<
  GraphRelationshipState,
  { stroke: string; strokeDasharray?: string; opacity: number }
> = {
  asserted: { stroke: "#2563eb", opacity: 1 },
  corroborated: { stroke: "#15803d", opacity: 1 },
  disputed: { stroke: "#b45309", strokeDasharray: "8 4", opacity: 1 },
  disproven: { stroke: "#dc2626", strokeDasharray: "2 5", opacity: 0.8 },
  inferred: { stroke: "#7c3aed", strokeDasharray: "4 4", opacity: 0.85 },
  inactive: { stroke: "#64748b", strokeDasharray: "1 5", opacity: 0.55 },
};
