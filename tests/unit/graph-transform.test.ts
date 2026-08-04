import { describe, expect, it } from "vitest";

import {
  deterministicCirclePositions,
  normalizeGraphFilter,
  shortestGraphPath,
  toGraphologyGraph,
  toRelationshipEditorGraph,
} from "@/modules/graph/transform";
import { graphResultFixture, IDS } from "../fixtures/graph";

describe("graph transforms", () => {
  it("preserves UUID keys, direction, self edges, and parallel edges", () => {
    const graph = toGraphologyGraph(graphResultFixture);

    expect(graph.nodes()).toEqual([IDS.alice, IDS.bob, IDS.casey]);
    expect(graph.edges()).toEqual([
      IDS.directed,
      IDS.parallel,
      IDS.undirected,
      IDS.self,
    ]);
    expect(graph.isDirected(IDS.directed)).toBe(true);
    expect(graph.isUndirected(IDS.undirected)).toBe(true);
    expect(graph.extremities(IDS.self)).toEqual([IDS.casey, IDS.casey]);
    expect(graph.getEdgeAttribute(IDS.parallel, "relationshipId")).toBe(
      IDS.parallel,
    );
  });

  it("creates deterministic nonzero circle positions independent of input order", () => {
    const expected = deterministicCirclePositions([
      IDS.casey,
      IDS.alice,
      IDS.bob,
    ]);
    expect(expected.map((position) => position.id)).toEqual([
      IDS.alice,
      IDS.bob,
      IDS.casey,
    ]);
    expect(new Set(expected.map(({ x, y }) => `${x},${y}`)).size).toBe(3);
    expect(expected.some(({ x, y }) => x !== 0 || y !== 0)).toBe(true);
  });

  it("normalizes bounded filters and rejects ambiguous temporal input", () => {
    expect(
      normalizeGraphFilter({
        mode: "NEIGHBORHOOD",
        rootPersonIds: [IDS.bob, IDS.alice, IDS.bob],
        relationshipTypeIds: [IDS.typeDirected, IDS.typeDirected],
      }),
    ).toMatchObject({
      mode: "NEIGHBORHOOD",
      rootPersonIds: [IDS.alice, IDS.bob],
      depth: 1,
      nodeLimit: 1000,
      edgeLimit: 4000,
    });
    expect(() =>
      normalizeGraphFilter({
        mode: "WORKSPACE",
        at: "2025-01-01T00:00:00.000Z",
        from: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow(/temporal/iu);
  });

  it("canonicalizes UUIDs to lowercase before deduplication", () => {
    expect(
      normalizeGraphFilter({
        mode: "NEIGHBORHOOD",
        rootPersonIds: [IDS.alice, IDS.alice.toUpperCase()],
        relationshipTypeIds: [IDS.typeDirected.toUpperCase(), IDS.typeDirected],
      }),
    ).toMatchObject({
      rootPersonIds: [IDS.alice],
      relationshipTypeIds: [IDS.typeDirected],
    });
  });

  it("accepts only the exact persisted relationship states", () => {
    expect(
      normalizeGraphFilter({
        mode: "WORKSPACE",
        relationshipStates: ["inactive", "asserted", "asserted"],
      }).relationshipStates,
    ).toEqual(["asserted", "inactive"]);
    expect(() =>
      normalizeGraphFilter({
        mode: "WORKSPACE",
        relationshipStates: ["draft"],
      }),
    ).toThrow(/relationshipStates/iu);
  });

  it("finds a deterministic path and respects natural direction", () => {
    expect(
      shortestGraphPath(graphResultFixture, IDS.alice, IDS.casey, "NATURAL"),
    ).toEqual({
      nodes: [IDS.alice, IDS.bob, IDS.casey],
      edges: [IDS.directed, IDS.undirected],
    });
    expect(
      shortestGraphPath(graphResultFixture, IDS.casey, IDS.alice, "NATURAL"),
    ).toBeNull();
    expect(
      shortestGraphPath(graphResultFixture, IDS.casey, IDS.alice, "UNDIRECTED")
        ?.nodes,
    ).toEqual([IDS.casey, IDS.bob, IDS.alice]);
  });

  it("caps the relationship editor to the visible one-hop neighborhood", () => {
    const editor = toRelationshipEditorGraph(graphResultFixture, IDS.alice);
    expect(editor.nodes).toHaveLength(2);
    expect(editor.edges).toHaveLength(2);
    expect(editor.truncated).toBe(false);
  });
});
