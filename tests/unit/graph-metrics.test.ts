import { describe, expect, it } from "vitest";

import {
  calculateGraphMetrics,
  graphAnalysisVersionContract,
} from "@/modules/graph/metrics";
import { graphResultFixture, IDS } from "../fixtures/graph";

describe("graph metrics", () => {
  it("calculates degree with UUID-tiebroken ranks and an exact version", () => {
    const metrics = calculateGraphMetrics(graphResultFixture, "DEGREE");
    expect(metrics).toHaveLength(3);
    expect(
      metrics.map(({ personId, value, rank }) => ({ personId, value, rank })),
    ).toEqual([
      { personId: IDS.alice, value: 2, rank: 3 },
      { personId: IDS.bob, value: 3, rank: 1 },
      { personId: IDS.casey, value: 3, rank: 2 },
    ]);
    expect(metrics[0]?.algorithmVersion).toBe(
      "graphology@0.26.0/degree/humans-v1",
    );
  });

  it("returns deterministic PageRank values for shuffled input", () => {
    const first = calculateGraphMetrics(graphResultFixture, "PAGERANK");
    const second = calculateGraphMetrics(
      {
        ...graphResultFixture,
        nodes: graphResultFixture.nodes.toReversed(),
        edges: graphResultFixture.edges.toReversed(),
      },
      "PAGERANK",
    );
    expect(second).toEqual(first);
    expect(
      first.every(({ value }) => Number.isFinite(value) && value >= 0),
    ).toBe(true);
    expect(first[0]?.algorithmVersion).toBe(
      "graphology-metrics@2.4.0/pagerank/humans-v2",
    );
  });

  it("recognizes only the shipped and current PageRank manifest contracts", () => {
    expect(
      graphAnalysisVersionContract(
        "PAGERANK",
        "graphology-metrics@2.4.0/pagerank/humans-v1",
      ),
    ).toMatchObject({
      configuration: { maxIterations: 100, tolerance: 1e-8 },
      version: "graphology-metrics@2.4.0/pagerank/humans-v1",
    });
    expect(
      graphAnalysisVersionContract(
        "PAGERANK",
        "graphology-metrics@2.4.0/pagerank/humans-v2",
      ),
    ).toMatchObject({
      configuration: { maxIterations: 200, tolerance: 1e-8 },
      version: "graphology-metrics@2.4.0/pagerank/humans-v2",
    });
    expect(graphAnalysisVersionContract("PAGERANK", "unknown")).toBeNull();
  });

  it("normalizes seeded Louvain communities by their smallest UUID", () => {
    const metrics = calculateGraphMetrics(
      graphResultFixture,
      "LOUVAIN_COMMUNITY",
    );
    expect(
      calculateGraphMetrics(graphResultFixture, "LOUVAIN_COMMUNITY"),
    ).toEqual(metrics);
    expect(metrics.map(({ value }) => value)).toEqual(
      [...metrics.map(({ value }) => value)].sort((a, b) => a - b),
    );
    expect(metrics[0]?.algorithmVersion).toBe(
      "graphology-communities-louvain@2.0.2/humans-undirected-v1",
    );
  });

  it("rejects algorithms above their public caps", () => {
    expect(() =>
      calculateGraphMetrics(
        {
          ...graphResultFixture,
          limits: { ...graphResultFixture.limits, returnedNodeCount: 2001 },
        },
        "PAGERANK",
      ),
    ).toThrow(/2,000 nodes/iu);
  });
});
