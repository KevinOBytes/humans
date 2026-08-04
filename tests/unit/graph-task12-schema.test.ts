import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  analysisResults,
  analysisRuns,
  graphSnapshots,
} from "@/db/schema/graph";

describe("Task 12 graph persistence contract", () => {
  it("persists an immutable reproducibility manifest", () => {
    const config = getTableConfig(graphSnapshots);
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "manifest_schema",
        "manifest_hash",
        "manifest_material",
        "query_hash",
        "authorization_hash",
        "actor_principal_id",
        "actor_kind",
        "included_relationship_type_versions",
        "algorithm",
        "algorithm_version",
        "algorithm_config_hash",
        "runtime_contract",
      ]),
    );
    expect(config.indexes.map(({ config: { name } }) => name)).toContain(
      "graph_snapshots_workspace_manifest_idx",
    );
    expect(config.checks.map(({ name }) => name)).toContain(
      "graph_snapshots_manifest_check",
    );
  });

  it("binds runs and typed results to versioned deterministic output", () => {
    const runs = getTableConfig(analysisRuns);
    expect(runs.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "algorithm_version",
        "configuration_hash",
        "actor_principal_id",
        "actor_kind",
      ]),
    );
    expect(runs.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "analysis_runs_contract_check",
        "analysis_runs_timing_check",
      ]),
    );
    const results = getTableConfig(analysisResults);
    expect(results.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "payload_schema",
        "payload_hash",
        "export_label",
      ]),
    );
    expect(results.checks.map(({ name }) => name)).toContain(
      "analysis_results_payload_check",
    );
  });
});
