"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { GraphFilterInput } from "@/graphql/generated/graphql";
import type { GraphResult } from "@/modules/graph/types";

export type GraphAnalysisAlgorithm =
  "DEGREE" | "PAGERANK" | "LOUVAIN_COMMUNITY";
export type GraphAnalysisRunSummary = {
  algorithm: string;
  completedAt: string | null;
  createdAt: string;
  graphSnapshotId: string;
  id: string;
  startedAt: string | null;
  state: string;
};
export type GraphAnalysisMetric = {
  algorithmVersion: string;
  explanation: string;
  metricKey: string;
  personId: string;
  rank: number;
  value: number;
};
export type GraphAnalysisResultItem = {
  createdAt: string;
  explanation: string | null;
  id: string;
  rank: number | null;
  resultKind: string;
  subjectPersonId: string | null;
  value: number | null;
};
export type GraphAnalysisPayload = {
  graph: GraphResult;
  metrics: readonly GraphAnalysisMetric[];
  run: GraphAnalysisRunSummary;
};
export type GraphSnapshotSummary = {
  algorithm: string;
  generatedAt: string;
  id: string;
  manifestHash: string;
};
export type GraphAnalysisExport = {
  content: string;
  contentType: string;
  filename: string;
  resultCount: number;
  truncated: boolean;
};
export type GraphAnalysisPageInfo = {
  endCursor: string | null;
  hasNextPage: boolean;
};
export type GraphAnalysisRunListPage = {
  nodes: readonly GraphAnalysisRunSummary[];
  pageInfo: GraphAnalysisPageInfo;
};
export type GraphAnalysisResultListPage = {
  nodes: readonly GraphAnalysisResultItem[];
  pageInfo: GraphAnalysisPageInfo;
};
export type GraphAnalysisAdapter = {
  createSnapshot?(input: {
    algorithm: GraphAnalysisAlgorithm;
    filter: GraphFilterInput;
    graphViewId?: string;
  }): Promise<GraphSnapshotSummary | null>;
  exportResults?(
    runId: string,
    format: "JSON" | "CSV",
  ): Promise<GraphAnalysisExport | null>;
  listRuns(after?: string): Promise<GraphAnalysisRunListPage>;
  results(runId: string, after?: string): Promise<GraphAnalysisResultListPage>;
  run(input: {
    algorithm: GraphAnalysisAlgorithm;
    filter: GraphFilterInput;
    graphViewId?: string;
  }): Promise<GraphAnalysisPayload | null>;
  rerun(input: {
    algorithm: GraphAnalysisAlgorithm;
    snapshotId: string;
  }): Promise<GraphAnalysisPayload | null>;
  replay?(snapshotId: string): Promise<{
    snapshot: GraphSnapshotSummary | null;
    valid: boolean;
  } | null>;
};

function downloadAnalysisExport(value: GraphAnalysisExport) {
  const url = URL.createObjectURL(
    new Blob([value.content], { type: value.contentType }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = value.filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const ALGORITHMS: ReadonlyArray<{
  id: GraphAnalysisAlgorithm;
  label: string;
  disclosure: string;
}> = [
  {
    id: "DEGREE",
    label: "Degree",
    disclosure:
      "Counts visible relationship incidence in this authorized snapshot; maximum 10,000 people and 25,000 relationships.",
  },
  {
    id: "PAGERANK",
    label: "PageRank",
    disclosure:
      "Ranks graph structure using relationship direction; maximum 2,000 people and 10,000 relationships. It is not a measure of human importance or truth.",
  },
  {
    id: "LOUVAIN_COMMUNITY",
    label: "Louvain community",
    disclosure:
      "Labels structural communities in a seeded undirected projection; maximum 2,000 people and 10,000 relationships. Labels do not imply affiliation or trust.",
  },
];

export function GraphAnalysis({
  adapter,
  canRun,
  currentFilter,
  currentViewId,
  onGraph,
  onStatus,
  result,
  workspaceIdentity,
}: {
  adapter: GraphAnalysisAdapter;
  canRun: boolean;
  currentFilter: GraphFilterInput;
  currentViewId?: string | null;
  onGraph: (result: GraphResult) => void;
  onStatus: (message: string) => void;
  result: GraphResult;
  workspaceIdentity: string;
}) {
  const generationRef = useRef(0);
  const requestEpochRef = useRef(0);
  const [algorithm, setAlgorithm] = useState<GraphAnalysisAlgorithm>("DEGREE");
  const [runs, setRuns] = useState<readonly GraphAnalysisRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [createdSnapshot, setCreatedSnapshot] =
    useState<GraphSnapshotSummary | null>(null);
  const [metrics, setMetrics] = useState<readonly GraphAnalysisMetric[]>([]);
  const [results, setResults] = useState<readonly GraphAnalysisResultItem[]>(
    [],
  );
  const [pending, setPending] = useState(false);
  const [runPageInfo, setRunPageInfo] = useState<GraphAnalysisPageInfo>({
    endCursor: null,
    hasNextPage: false,
  });
  const [seenRunCursors, setSeenRunCursors] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [resultPageInfo, setResultPageInfo] = useState<GraphAnalysisPageInfo>({
    endCursor: null,
    hasNextPage: false,
  });
  const [seenResultCursors, setSeenResultCursors] = useState<
    ReadonlySet<string>
  >(new Set());
  const [stateSource, setStateSource] = useState({
    adapter,
    workspaceIdentity,
  });
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const names = useMemo(
    () => new Map(result.nodes.map((node) => [node.id, node.displayName])),
    [result.nodes],
  );
  const disclosure = ALGORITHMS.find((item) => item.id === algorithm)!;
  const replaySnapshotId =
    createdSnapshot?.id ?? selectedRun?.graphSnapshotId ?? null;

  if (
    stateSource.adapter !== adapter ||
    stateSource.workspaceIdentity !== workspaceIdentity
  ) {
    setStateSource({ adapter, workspaceIdentity });
    setRuns([]);
    setSelectedRunId("");
    setCreatedSnapshot(null);
    setMetrics([]);
    setResults([]);
    setRunPageInfo({ endCursor: null, hasNextPage: false });
    setSeenRunCursors(new Set());
    setResultPageInfo({ endCursor: null, hasNextPage: false });
    setSeenResultCursors(new Set());
    setPending(false);
  }

  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [adapter, onStatus, workspaceIdentity]);

  function beginRequest() {
    requestEpochRef.current += 1;
    return requestEpochRef.current;
  }

  function isCurrent(generation: number, requestEpoch: number) {
    return (
      generation === generationRef.current &&
      requestEpoch === requestEpochRef.current
    );
  }

  useEffect(() => {
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    adapter
      .listRuns()
      .then((page) => {
        if (!isCurrent(generation, requestEpoch)) return;
        if (
          (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
          new Set(page.nodes.map((run) => run.id)).size !== page.nodes.length
        ) {
          throw new Error("Graph analysis pagination was invalid.");
        }
        setRuns(page.nodes);
        setRunPageInfo(page.pageInfo);
        setSeenRunCursors(
          page.pageInfo.endCursor
            ? new Set([page.pageInfo.endCursor])
            : new Set(),
        );
      })
      .catch(() => {
        if (isCurrent(generation, requestEpoch)) {
          onStatus("Graph analysis runs could not be listed.");
        }
      });
  }, [adapter, onStatus, workspaceIdentity]);

  async function loadResults(runId: string) {
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setCreatedSnapshot(null);
    setSelectedRunId(runId);
    setMetrics([]);
    setResults([]);
    setResultPageInfo({ endCursor: null, hasNextPage: false });
    setSeenResultCursors(new Set());
    if (!runId) {
      setPending(false);
      return;
    }
    setPending(true);
    try {
      const page = await adapter.results(runId);
      if (!isCurrent(generation, requestEpoch)) return;
      if (
        (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
        new Set(page.nodes.map((item) => item.id)).size !== page.nodes.length
      ) {
        throw new Error("Graph analysis result pagination was invalid.");
      }
      setResults(page.nodes);
      setResultPageInfo(page.pageInfo);
      setSeenResultCursors(
        page.pageInfo.endCursor
          ? new Set([page.pageInfo.endCursor])
          : new Set(),
      );
      onStatus("Stored graph analysis results loaded.");
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Stored graph analysis results could not be loaded.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function loadMoreResults() {
    if (
      pending ||
      !selectedRunId ||
      !resultPageInfo.hasNextPage ||
      !resultPageInfo.endCursor
    )
      return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    const runId = selectedRunId;
    const after = resultPageInfo.endCursor;
    setPending(true);
    try {
      const page = await adapter.results(runId, after);
      if (!isCurrent(generation, requestEpoch)) return;
      const pageIds = new Set(page.nodes.map((item) => item.id));
      if (
        (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
        (page.pageInfo.endCursor &&
          seenResultCursors.has(page.pageInfo.endCursor)) ||
        pageIds.size !== page.nodes.length ||
        results.some((item) => pageIds.has(item.id))
      ) {
        throw new Error("Graph analysis result pagination did not advance.");
      }
      setResults((current) => [...current, ...page.nodes]);
      setResultPageInfo(page.pageInfo);
      if (page.pageInfo.endCursor) {
        setSeenResultCursors(
          (current) => new Set([...current, page.pageInfo.endCursor!]),
        );
      }
      onStatus(
        page.pageInfo.hasNextPage
          ? "More graph analysis results loaded. Additional pages remain."
          : "All graph analysis results are loaded.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("More graph analysis results could not be loaded.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function loadMoreRuns() {
    if (pending || !runPageInfo.hasNextPage || !runPageInfo.endCursor) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const page = await adapter.listRuns(runPageInfo.endCursor);
      if (!isCurrent(generation, requestEpoch)) return;
      const pageIds = new Set(page.nodes.map((run) => run.id));
      if (
        (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) ||
        (page.pageInfo.endCursor &&
          seenRunCursors.has(page.pageInfo.endCursor)) ||
        pageIds.size !== page.nodes.length ||
        runs.some((run) => pageIds.has(run.id))
      ) {
        throw new Error("Graph analysis pagination did not advance.");
      }
      setRuns((current) => [...current, ...page.nodes]);
      setRunPageInfo(page.pageInfo);
      if (page.pageInfo.endCursor) {
        setSeenRunCursors(
          (current) => new Set([...current, page.pageInfo.endCursor!]),
        );
      }
      onStatus(
        page.pageInfo.hasNextPage
          ? "More graph analysis runs loaded. Additional pages remain."
          : "All graph analysis runs are loaded.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("More graph analysis runs could not be loaded.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  function accept(
    payload: GraphAnalysisPayload | null,
    generation: number,
    requestEpoch: number,
  ) {
    if (!isCurrent(generation, requestEpoch)) return;
    if (!payload) {
      onStatus("Graph analysis did not return a result.");
      return;
    }
    setRuns((current) => [
      payload.run,
      ...current.filter((run) => run.id !== payload.run.id),
    ]);
    setSelectedRunId(payload.run.id);
    setCreatedSnapshot(null);
    setMetrics(payload.metrics);
    setResults([]);
    setResultPageInfo({ endCursor: null, hasNextPage: false });
    setSeenResultCursors(new Set());
    onGraph(payload.graph);
    onStatus(
      `${disclosure.label} analysis completed with ${payload.metrics.length} metrics.`,
    );
  }

  async function run() {
    if (pending || !canRun) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    onStatus(`Running bounded ${disclosure.label} analysis.`);
    try {
      accept(
        await adapter.run({
          algorithm,
          filter: currentFilter,
          ...(currentViewId ? { graphViewId: currentViewId } : {}),
        }),
        generation,
        requestEpoch,
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("Graph analysis could not be completed.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function rerun() {
    if (pending || !canRun || !selectedRun) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    onStatus(
      `Rerunning ${disclosure.label} against the stored snapshot manifest.`,
    );
    try {
      accept(
        await adapter.rerun({
          algorithm,
          snapshotId: selectedRun.graphSnapshotId,
        }),
        generation,
        requestEpoch,
      );
    } catch {
      if (isCurrent(generation, requestEpoch)) {
        onStatus("The graph analysis snapshot could not be rerun.");
      }
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function createSnapshot() {
    if (pending || !canRun || !adapter.createSnapshot) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const snapshot = await adapter.createSnapshot({
        algorithm,
        filter: currentFilter,
        ...(currentViewId ? { graphViewId: currentViewId } : {}),
      });
      if (!isCurrent(generation, requestEpoch)) return;
      setCreatedSnapshot(snapshot);
      onStatus(
        snapshot
          ? `Reproducibility snapshot created for ${disclosure.label}.`
          : "The graph snapshot was not created.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch))
        onStatus("The graph snapshot could not be created.");
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function replaySnapshot() {
    if (pending || !canRun || !replaySnapshotId || !adapter.replay) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const replay = await adapter.replay(replaySnapshotId);
      if (!isCurrent(generation, requestEpoch)) return;
      onStatus(
        replay?.valid
          ? "The selected snapshot is reproducible with current authorized data."
          : "The selected snapshot is no longer reproducible.",
      );
    } catch {
      if (isCurrent(generation, requestEpoch))
        onStatus("Snapshot validity could not be checked.");
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  async function exportResults(format: "JSON" | "CSV") {
    if (pending || !selectedRun || !adapter.exportResults) return;
    const generation = generationRef.current;
    const requestEpoch = beginRequest();
    setPending(true);
    try {
      const exported = await adapter.exportResults(selectedRun.id, format);
      if (!isCurrent(generation, requestEpoch)) return;
      if (!exported) throw new Error("The export response was empty.");
      downloadAnalysisExport(exported);
      onStatus(
        `${format} analysis export prepared with ${exported.resultCount} results${
          exported.truncated ? " (bounded page)" : ""
        }.`,
      );
    } catch {
      if (isCurrent(generation, requestEpoch))
        onStatus("The analysis export could not be prepared.");
    } finally {
      if (isCurrent(generation, requestEpoch)) setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="graph-analysis-heading"
      className="border-border bg-card rounded-2xl border p-4 shadow-sm"
    >
      <h2 id="graph-analysis-heading" className="font-semibold">
        Structural analysis
      </h2>
      <p className="text-muted-foreground mt-1 text-xs">
        Results describe only this bounded authorized graph snapshot. They are
        structural calculations, not conclusions about people.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="graph-analysis-algorithm">Algorithm</Label>
          <select
            id="graph-analysis-algorithm"
            className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
            value={algorithm}
            onChange={(event) =>
              setAlgorithm(event.target.value as GraphAnalysisAlgorithm)
            }
          >
            {ALGORITHMS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="graph-analysis-run">Previous run</Label>
          <select
            id="graph-analysis-run"
            className="border-input bg-background mt-2 min-h-11 w-full rounded-xl border px-3 text-sm"
            value={selectedRunId}
            onChange={(event) => void loadResults(event.target.value)}
          >
            <option value="">Choose an analysis run</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.algorithm} — {run.state} — {run.createdAt}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        {disclosure.disclosure}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" disabled={!canRun || pending} onClick={run}>
          {pending ? "Working…" : "Run analysis"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canRun || pending || !adapter.createSnapshot}
          onClick={createSnapshot}
        >
          Create snapshot
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canRun || pending || !selectedRun}
          onClick={rerun}
        >
          Create new analysis from snapshot
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canRun || pending || !replaySnapshotId || !adapter.replay}
          onClick={replaySnapshot}
        >
          Check snapshot validity
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !selectedRun || !adapter.exportResults}
          onClick={() => void exportResults("JSON")}
        >
          Export results JSON
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !selectedRun || !adapter.exportResults}
          onClick={() => void exportResults("CSV")}
        >
          Export results CSV
        </Button>
        {runPageInfo.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || !runPageInfo.endCursor}
            onClick={loadMoreRuns}
          >
            Load more analysis runs
          </Button>
        ) : null}
      </div>
      {createdSnapshot ? (
        <section
          aria-labelledby="latest-created-graph-snapshot-heading"
          className="mt-4"
        >
          <h3 id="latest-created-graph-snapshot-heading" className="sr-only">
            Latest created graph snapshot
          </h3>
          <dl className="text-muted-foreground grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="font-semibold">Snapshot ID</dt>
              <dd className="font-mono break-all">{createdSnapshot.id}</dd>
            </div>
            <div>
              <dt className="font-semibold">Algorithm</dt>
              <dd>{createdSnapshot.algorithm}</dd>
            </div>
            <div>
              <dt className="font-semibold">Generated</dt>
              <dd>{createdSnapshot.generatedAt}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {selectedRun ? (
        <dl className="text-muted-foreground mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="font-semibold">State</dt>
            <dd>{selectedRun.state}</dd>
          </div>
          <div>
            <dt className="font-semibold">Algorithm</dt>
            <dd>{selectedRun.algorithm}</dd>
          </div>
          <div>
            <dt className="font-semibold">Snapshot</dt>
            <dd className="font-mono break-all">
              {selectedRun.graphSnapshotId}
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Completed</dt>
            <dd>{selectedRun.completedAt ?? "Not completed"}</dd>
          </div>
        </dl>
      ) : null}
      {metrics.length ? (
        <div className="mt-5 overflow-x-auto">
          <table
            className="w-full text-left text-sm"
            aria-label="New graph analysis metrics"
          >
            <caption className="sr-only">New graph analysis metrics</caption>
            <thead>
              <tr>
                <th>Person</th>
                <th>Metric</th>
                <th>Value</th>
                <th>Rank</th>
                <th>Version and explanation</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={`${metric.personId}:${metric.metricKey}`}>
                  <td>{names.get(metric.personId) ?? metric.personId}</td>
                  <td>{metric.metricKey}</td>
                  <td>{metric.value}</td>
                  <td>{metric.rank}</td>
                  <td>
                    <span className="font-mono text-xs">
                      {metric.algorithmVersion}
                    </span>
                    <br />
                    {metric.explanation}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {results.length ? (
        <div className="mt-5 overflow-x-auto">
          <table
            className="w-full text-left text-sm"
            aria-label="Stored graph analysis results"
          >
            <caption className="sr-only">Stored graph analysis results</caption>
            <thead>
              <tr>
                <th>Person</th>
                <th>Kind</th>
                <th>Value</th>
                <th>Rank</th>
                <th>Explanation</th>
              </tr>
            </thead>
            <tbody>
              {results.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.subjectPersonId
                      ? (names.get(item.subjectPersonId) ??
                        item.subjectPersonId)
                      : "Graph"}
                  </td>
                  <td>{item.resultKind}</td>
                  <td>{item.value ?? "Not numeric"}</td>
                  <td>{item.rank ?? "Not ranked"}</td>
                  <td>{item.explanation ?? "No explanation"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {resultPageInfo.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          disabled={pending || !resultPageInfo.endCursor}
          onClick={loadMoreResults}
        >
          Load more analysis results
        </Button>
      ) : null}
    </section>
  );
}
