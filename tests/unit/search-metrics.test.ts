import { describe, expect, it, vi } from "vitest";

import {
  createProductionMetricsSink,
  createTask12Metrics,
  disabledMetricsSink,
  type MetricsSink,
} from "@/modules/search/metrics";

describe("Task 12 low-cardinality metrics", () => {
  it("emits only reviewed names and label dimensions", () => {
    const increment = vi.fn<MetricsSink["increment"]>();
    const observe = vi.fn<MetricsSink["observe"]>();
    const metrics = createTask12Metrics({ increment, observe });

    metrics.searchRequest({
      durationSeconds: 0.125,
      mode: "TEXT",
      outcome: "SUCCESS",
      resultCount: 3,
    });
    metrics.operationBudget({
      dimension: "CLIENT",
      durationSeconds: 0.01,
      operation: "SEARCH_READ",
      outcome: "ALLOWED",
    });

    expect(increment.mock.calls).toEqual([
      ["search_requests_total", { mode: "TEXT", outcome: "SUCCESS" }, 1],
      ["search_results_count", { mode: "TEXT" }, 3],
      [
        "operation_budget_checks_total",
        { dimension: "CLIENT", operation: "SEARCH_READ", outcome: "ALLOWED" },
        1,
      ],
    ]);
    expect(observe.mock.calls).toEqual([
      ["search_duration_seconds", { mode: "TEXT" }, 0.125],
      ["operation_budget_duration_seconds", { operation: "SEARCH_READ" }, 0.01],
    ]);
    expect(JSON.stringify(increment.mock.calls)).not.toContain("workspace");
  });

  it("provides an explicit disabled sink without retaining values", () => {
    const metrics = createTask12Metrics(disabledMetricsSink);
    expect(() => metrics.savedQueryRun({ outcome: "ERROR" })).not.toThrow();
    expect(() => metrics.snapshotReplay({ outcome: "INVALID" })).not.toThrow();
  });

  it("emits reviewed production events without sensitive dimensions", () => {
    const write = vi.fn();
    const metrics = createTask12Metrics(createProductionMetricsSink(write));

    metrics.analysisRun({ algorithm: "PAGERANK", outcome: "SUCCESS" });
    metrics.indexMaintenance({ outcome: "UPSERTED", sourceKind: "person" });

    expect(write.mock.calls).toEqual([
      [
        {
          kind: "counter",
          labels: { algorithm: "PAGERANK", outcome: "SUCCESS" },
          name: "graph_analysis_runs_total",
          value: 1,
        },
      ],
      [
        {
          kind: "counter",
          labels: { outcome: "UPSERTED", source_kind: "person" },
          name: "search_index_maintenance_total",
          value: 1,
        },
      ],
    ]);
    expect(JSON.stringify(write.mock.calls)).not.toMatch(
      /workspace|request|query|principal|actor|@/u,
    );
  });

  it("drops unknown names, labels, and label values", () => {
    const write = vi.fn();
    const sink = createProductionMetricsSink(write);

    sink.increment("custom_metric", {}, 1);
    sink.increment(
      "search_requests_total",
      { mode: "TEXT", outcome: "SUCCESS", workspace: "secret" },
      1,
    );
    sink.increment(
      "search_index_maintenance_total",
      { outcome: "UPSERTED", source_kind: "person@example.com" },
      1,
    );

    expect(write).not.toHaveBeenCalled();
  });

  it("isolates production writer failures", () => {
    const sink = createProductionMetricsSink(() => {
      throw new Error("provider unavailable");
    });
    const metrics = createTask12Metrics(sink);

    expect(() => metrics.snapshotReplay({ outcome: "INVALID" })).not.toThrow();
    expect(() =>
      sink.increment("saved_query_runs_total", { outcome: "ERROR" }, 1),
    ).not.toThrow();
  });
});
