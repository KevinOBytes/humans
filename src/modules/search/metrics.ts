import "server-only";

import { SEARCH_INDEX_SOURCE_KINDS } from "./index-maintenance";

export interface MetricsSink {
  increment(
    name: string,
    labels: Readonly<Record<string, string>>,
    value: number,
  ): void;
  observe(
    name: string,
    labels: Readonly<Record<string, string>>,
    value: number,
  ): void;
}

export const disabledMetricsSink: MetricsSink = Object.freeze({
  increment() {},
  observe() {},
});

export type ProductionMetricEvent = Readonly<{
  kind: "counter" | "histogram";
  labels: Readonly<Record<string, string>>;
  name: string;
  value: number;
}>;

const VALUES = Object.freeze({
  algorithm: ["DEGREE", "PAGERANK", "LOUVAIN_COMMUNITY"],
  dimension: ["ACTOR", "WORKSPACE", "CLIENT"],
  format: ["JSON", "CSV"],
  mode: ["TEXT", "PROTECTED_EXACT"],
  operation: [
    "SEARCH_READ",
    "SAVED_QUERY_RUN",
    "GRAPH_SNAPSHOT",
    "ANALYSIS_RUN",
    "ANALYSIS_EXPORT",
    "ANALYSIS_READ",
  ],
  outcome: [
    "SUCCESS",
    "EMPTY",
    "INVALID",
    "DENIED",
    "UNAVAILABLE",
    "ERROR",
    "CONFLICT",
    "VALID",
    "ALLOWED",
    "UPSERTED",
    "REMOVED",
    "STALE",
  ],
  source_kind: SEARCH_INDEX_SOURCE_KINDS,
} satisfies Readonly<Record<string, readonly string[]>>);

const PRODUCTION_METRIC_CONTRACT = Object.freeze({
  search_requests_total: { kind: "counter", labels: ["mode", "outcome"] },
  search_results_count: { kind: "counter", labels: ["mode"] },
  search_duration_seconds: { kind: "histogram", labels: ["mode"] },
  saved_query_runs_total: { kind: "counter", labels: ["outcome"] },
  graph_snapshot_replays_total: { kind: "counter", labels: ["outcome"] },
  graph_snapshot_creates_total: { kind: "counter", labels: ["outcome"] },
  graph_analysis_runs_total: {
    kind: "counter",
    labels: ["algorithm", "outcome"],
  },
  graph_analysis_exports_total: {
    kind: "counter",
    labels: ["format", "outcome"],
  },
  operation_budget_checks_total: {
    kind: "counter",
    labels: ["dimension", "operation", "outcome"],
  },
  operation_budget_duration_seconds: {
    kind: "histogram",
    labels: ["operation"],
  },
  search_index_maintenance_total: {
    kind: "counter",
    labels: ["outcome", "source_kind"],
  },
} as const);

function defaultMetricWriter(event: ProductionMetricEvent): void {
  console.info(
    JSON.stringify({ event: "humans.task12.metric.v1", metric: event }),
  );
}

export function createProductionMetricsSink(
  write: (event: ProductionMetricEvent) => void = defaultMetricWriter,
): MetricsSink {
  const emit = (
    kind: ProductionMetricEvent["kind"],
    name: string,
    labels: Readonly<Record<string, string>>,
    value: number,
  ) => {
    const contract =
      PRODUCTION_METRIC_CONTRACT[
        name as keyof typeof PRODUCTION_METRIC_CONTRACT
      ];
    if (
      !contract ||
      contract.kind !== kind ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 10_000
    )
      return;
    const actualKeys = Object.keys(labels).sort();
    const expectedKeys = [...contract.labels].sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    )
      return;
    const safeLabels: Record<string, string> = {};
    for (const key of expectedKeys) {
      const allowed = VALUES[key as keyof typeof VALUES];
      const labelValue = labels[key];
      if (!labelValue || !allowed.includes(labelValue as never)) return;
      safeLabels[key] = labelValue;
    }
    try {
      write(
        Object.freeze({ kind, labels: Object.freeze(safeLabels), name, value }),
      );
    } catch {
      // Observability must not become a product availability dependency.
    }
  };
  const sink: MetricsSink = {
    increment(name, labels, value) {
      emit("counter", name, labels, value);
    },
    observe(name, labels, value) {
      emit("histogram", name, labels, value);
    },
  };
  return Object.freeze(sink);
}

export const productionMetricsSink = createProductionMetricsSink();

export type Task12Metrics = Readonly<{
  searchRequest(input: {
    durationSeconds: number;
    mode: "TEXT" | "PROTECTED_EXACT";
    outcome:
      "SUCCESS" | "EMPTY" | "INVALID" | "DENIED" | "UNAVAILABLE" | "ERROR";
    resultCount: number;
  }): void;
  savedQueryRun(input: {
    outcome: "SUCCESS" | "DENIED" | "CONFLICT" | "ERROR";
  }): void;
  snapshotReplay(input: {
    outcome: "VALID" | "INVALID" | "DENIED" | "ERROR";
  }): void;
  snapshotCreate(input: { outcome: "SUCCESS" | "DENIED" | "ERROR" }): void;
  analysisRun(input: {
    algorithm: "DEGREE" | "PAGERANK" | "LOUVAIN_COMMUNITY";
    outcome: "SUCCESS" | "DENIED" | "INVALID" | "ERROR";
  }): void;
  analysisExport(input: {
    format: "JSON" | "CSV";
    outcome: "SUCCESS" | "DENIED" | "INVALID" | "ERROR";
  }): void;
  operationBudget(input: {
    dimension: "ACTOR" | "WORKSPACE" | "CLIENT";
    durationSeconds: number;
    operation:
      | "SEARCH_READ"
      | "SAVED_QUERY_RUN"
      | "GRAPH_SNAPSHOT"
      | "ANALYSIS_RUN"
      | "ANALYSIS_EXPORT"
      | "ANALYSIS_READ";
    outcome: "ALLOWED" | "DENIED" | "UNAVAILABLE";
  }): void;
  indexMaintenance(input: {
    outcome: "UPSERTED" | "REMOVED" | "STALE" | "ERROR";
    sourceKind: string;
  }): void;
}>;

function bounded(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), maximum) : 0;
}

export function createTask12Metrics(sink: MetricsSink): Task12Metrics {
  const increment = (
    name: string,
    labels: Readonly<Record<string, string>>,
    value = 1,
  ) => {
    try {
      sink.increment(name, labels, bounded(value, 10_000));
    } catch {
      // Metrics are diagnostic and never become an authorization dependency.
    }
  };
  const observe = (
    name: string,
    labels: Readonly<Record<string, string>>,
    value: number,
  ) => {
    try {
      sink.observe(name, labels, bounded(value, 300));
    } catch {
      // A metrics provider failure must not alter the product operation.
    }
  };
  return Object.freeze({
    searchRequest(input) {
      increment("search_requests_total", {
        mode: input.mode,
        outcome: input.outcome,
      });
      increment(
        "search_results_count",
        { mode: input.mode },
        input.resultCount,
      );
      observe(
        "search_duration_seconds",
        { mode: input.mode },
        input.durationSeconds,
      );
    },
    savedQueryRun(input) {
      increment("saved_query_runs_total", { outcome: input.outcome });
    },
    snapshotReplay(input) {
      increment("graph_snapshot_replays_total", { outcome: input.outcome });
    },
    snapshotCreate(input) {
      increment("graph_snapshot_creates_total", { outcome: input.outcome });
    },
    analysisRun(input) {
      increment("graph_analysis_runs_total", {
        algorithm: input.algorithm,
        outcome: input.outcome,
      });
    },
    analysisExport(input) {
      increment("graph_analysis_exports_total", {
        format: input.format,
        outcome: input.outcome,
      });
    },
    operationBudget(input) {
      increment("operation_budget_checks_total", {
        dimension: input.dimension,
        operation: input.operation,
        outcome: input.outcome,
      });
      observe(
        "operation_budget_duration_seconds",
        { operation: input.operation },
        input.durationSeconds,
      );
    },
    indexMaintenance(input) {
      increment("search_index_maintenance_total", {
        outcome: input.outcome,
        source_kind: input.sourceKind,
      });
    },
  });
}
