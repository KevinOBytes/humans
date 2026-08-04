"use client";

import dynamic from "next/dynamic";
import {
  CircleDot,
  Focus,
  Link2,
  Network,
  Pause,
  Play,
  TableProperties,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { executeBrowserGraphQL } from "@/graphql/client";
import {
  ArchiveRelationshipDocument,
  CreateRelationshipDocument,
  GraphPageDocument,
  type GraphRelationshipState,
  UpdateRelationshipDocument,
  type GraphFilterInput,
  type Sensitivity,
} from "@/graphql/generated/graphql";
import {
  deterministicCirclePositions,
  shortestGraphPath,
} from "@/modules/graph/transform";
import type { GraphPosition, GraphResult } from "@/modules/graph/types";

import { GraphExportMenu } from "./graph-export-menu";
import { GraphFilterControls } from "./graph-filter-controls";
import {
  createBrowserGraphAnalysisAdapter,
  createBrowserSavedViewAdapter,
} from "./graph-browser-adapters";
import { GraphAnalysis, type GraphAnalysisAdapter } from "./graph-analysis";
import { GraphInspector } from "./graph-inspector";
import { graphPageResult } from "./graph-page-model";
import { GraphRenderer, type GraphRendererCommand } from "./graph-renderer";
import { GraphTable, type GraphSelection } from "./graph-table";
import {
  GraphSavedViews,
  type GraphSavedViewAdapter,
  type GraphSavedViewRun,
  type GraphSavedViewSummary,
} from "./graph-saved-views";
import type {
  RelationshipEditorMutationAdapter,
  RelationshipTypeOption,
} from "./relationship-editor";

const RelationshipEditor = dynamic(
  () =>
    import("./relationship-editor").then((module) => module.RelationshipEditor),
  { ssr: false },
);
const EMPTY_POSITIONS: readonly GraphPosition[] = [];

export type GraphExplorerProps = {
  analysisAdapter?: GraphAnalysisAdapter;
  canArchiveRelationships?: boolean;
  canArchiveViews?: boolean;
  canCreateRelationships?: boolean;
  canEditRelationships?: boolean;
  canReadAnalysis?: boolean;
  canReadViews?: boolean;
  canRunAnalysis?: boolean;
  canSaveViews?: boolean;
  canUpdateRelationships?: boolean;
  canUpdateViews?: boolean;
  initialLayoutAlgorithm?: "CIRCLE" | "FORCE_ATLAS_2";
  initialPositions?: readonly GraphPosition[];
  initialPositionsTruncated?: boolean;
  initialSavedView?: GraphSavedViewSummary | null;
  initialViewId?: string | null;
  queryAdapter?: GraphQueryAdapter;
  relationshipTypes?: readonly RelationshipTypeOption[];
  relationshipTypesTruncated?: boolean;
  result: GraphResult;
  savedViewAdapter?: GraphSavedViewAdapter;
  workspaceIdentity: string;
};

export type GraphQueryAdapter = (
  filter: GraphFilterInput,
) => Promise<GraphResult>;

async function queryGeneratedGraph(filter: GraphFilterInput) {
  const response = await executeBrowserGraphQL(GraphPageDocument, { filter });
  if (!response.ok) {
    throw new Error(
      response.errors[0]?.message ?? "The generated graph could not be loaded.",
    );
  }
  if (!response.data.graph) {
    throw new Error("The generated graph could not be loaded.");
  }
  return graphPageResult(response.data.graph);
}

function command(
  previous: GraphRendererCommand | undefined,
  type: GraphRendererCommand["type"],
): GraphRendererCommand {
  return { id: (previous?.id ?? 0) + 1, type };
}

function graphViewFilter(
  filter: GraphResult["normalizedFilter"],
): GraphFilterInput {
  return {
    mode: filter.mode,
    rootPersonIds: filter.rootPersonIds,
    depth: filter.depth,
    relationshipTypeIds: filter.relationshipTypeIds,
    relationshipStates: filter.relationshipStates.map(
      (value) => value.toUpperCase() as GraphRelationshipState,
    ),
    sensitivities: filter.sensitivities.map(
      (value) => value.toUpperCase() as Sensitivity,
    ),
    minimumConfidence: filter.minimumConfidence ?? undefined,
    at: filter.at ?? undefined,
    from: filter.from ?? undefined,
    until: filter.until ?? undefined,
    nodeLimit: filter.nodeLimit,
    edgeLimit: filter.edgeLimit,
    includeIsolates: filter.includeIsolates,
  };
}

export function GraphExplorer({
  analysisAdapter,
  canArchiveRelationships,
  canArchiveViews = false,
  canCreateRelationships,
  canEditRelationships = false,
  canReadAnalysis = false,
  canReadViews = false,
  canRunAnalysis = false,
  canSaveViews = false,
  canUpdateRelationships,
  canUpdateViews = false,
  initialLayoutAlgorithm = "CIRCLE",
  initialPositions = EMPTY_POSITIONS,
  initialPositionsTruncated = false,
  initialSavedView = null,
  initialViewId = null,
  queryAdapter = queryGeneratedGraph,
  relationshipTypes = [],
  relationshipTypesTruncated = false,
  result: initialResult,
  savedViewAdapter,
  workspaceIdentity,
}: GraphExplorerProps) {
  const generationRef = useRef(0);
  const effectiveSavedViewAdapter = useMemo(
    () =>
      savedViewAdapter ??
      (canReadViews
        ? createBrowserSavedViewAdapter(workspaceIdentity)
        : undefined),
    [canReadViews, savedViewAdapter, workspaceIdentity],
  );
  const effectiveAnalysisAdapter = useMemo(
    () =>
      analysisAdapter ??
      (canReadAnalysis
        ? createBrowserGraphAnalysisAdapter(workspaceIdentity)
        : undefined),
    [analysisAdapter, canReadAnalysis, workspaceIdentity],
  );
  const [result, setResult] = useState(initialResult);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GraphSelection>(null);
  const [pathMode, setPathMode] = useState(false);
  const [pathEndpoints, setPathEndpoints] = useState<string[]>([]);
  const [path, setPath] = useState<{ nodes: string[]; edges: string[] } | null>(
    null,
  );
  const [rendererCommand, setRendererCommand] =
    useState<GraphRendererCommand>();
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [layoutAlgorithm, setLayoutAlgorithm] = useState(
    initialLayoutAlgorithm,
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [savedViewId, setSavedViewId] = useState<string | null>(initialViewId);
  const [operationStatus, setOperationStatus] = useState("");
  const [positions, setPositions] = useState<readonly GraphPosition[]>(() =>
    initialPositions.length
      ? initialPositions
      : deterministicCirclePositions(result.nodes.map((node) => node.id)),
  );
  const [initialSource, setInitialSource] = useState({
    initialLayoutAlgorithm,
    initialPositions,
    initialResult,
    initialViewId,
    workspaceIdentity,
  });
  const inspectorFocusRef = useRef<HTMLElement | null>(null);

  if (
    initialSource.initialLayoutAlgorithm !== initialLayoutAlgorithm ||
    initialSource.initialPositions !== initialPositions ||
    initialSource.initialResult !== initialResult ||
    initialSource.initialViewId !== initialViewId ||
    initialSource.workspaceIdentity !== workspaceIdentity
  ) {
    setInitialSource({
      initialLayoutAlgorithm,
      initialPositions,
      initialResult,
      initialViewId,
      workspaceIdentity,
    });
    setResult(initialResult);
    setFilter("");
    setSelected(null);
    setPathMode(false);
    setPath(null);
    setPathEndpoints([]);
    setRendererCommand(undefined);
    setLayoutRunning(false);
    setLayoutAlgorithm(initialLayoutAlgorithm);
    setEditorOpen(false);
    setSavedViewId(initialViewId);
    setOperationStatus("");
    setPositions(
      initialPositions.length
        ? initialPositions
        : deterministicCirclePositions(
            initialResult.nodes.map((node) => node.id),
          ),
    );
  }

  useLayoutEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [
    initialLayoutAlgorithm,
    initialPositions,
    initialResult,
    initialViewId,
    workspaceIdentity,
  ]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleNodeIds = useMemo(() => {
    if (!normalizedFilter) return new Set(result.nodes.map((node) => node.id));
    return new Set(
      result.nodes
        .filter((node) =>
          node.displayName.toLocaleLowerCase().includes(normalizedFilter),
        )
        .map((node) => node.id),
    );
  }, [normalizedFilter, result.nodes]);
  const visibleEdgeIds = useMemo(() => {
    if (!normalizedFilter) {
      return new Set(result.edges.map((edge) => edge.id));
    }
    return new Set(
      result.edges
        .filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        )
        .map((edge) => edge.id),
    );
  }, [normalizedFilter, result.edges, visibleNodeIds]);
  const pathNodeIds = useMemo(() => new Set(path?.nodes ?? []), [path]);
  const pathEdgeIds = useMemo(() => new Set(path?.edges ?? []), [path]);
  const selectedNodeId = selected?.kind === "node" ? selected.id : null;
  const mayCreate = canCreateRelationships ?? canEditRelationships;
  const mayUpdate = canUpdateRelationships ?? canEditRelationships;
  const mayArchive = canArchiveRelationships ?? canEditRelationships;
  const mayEdit = mayCreate || mayUpdate || mayArchive;
  const mutationAdapter = useMemo<RelationshipEditorMutationAdapter>(() => {
    void workspaceIdentity;
    return {
      create: mayCreate
        ? async (input) => {
            const generation = generationRef.current;
            const response = await executeBrowserGraphQL(
              CreateRelationshipDocument,
              { input },
            );
            if (generation !== generationRef.current) return false;
            if (!response.ok) {
              setOperationStatus(
                response.errors[0]?.message ??
                  "The relationship could not be created.",
              );
              return false;
            }
            return Boolean(response.data.createRelationship?.relationship);
          }
        : undefined,
      update: mayUpdate
        ? async ({ expectedVersion, relationshipId, sensitivity }) => {
            const generation = generationRef.current;
            const response = await executeBrowserGraphQL(
              UpdateRelationshipDocument,
              {
                input: {
                  expectedVersion,
                  id: relationshipId,
                  sensitivity,
                },
              },
            );
            if (generation !== generationRef.current) return false;
            if (!response.ok) {
              setOperationStatus(
                response.errors[0]?.message ??
                  "The relationship could not be updated.",
              );
              return false;
            }
            return Boolean(response.data.updateRelationship?.relationship);
          }
        : undefined,
      archive: mayArchive
        ? async ({ expectedVersion, relationshipId }) => {
            const generation = generationRef.current;
            const response = await executeBrowserGraphQL(
              ArchiveRelationshipDocument,
              { input: { expectedVersion, id: relationshipId } },
            );
            if (generation !== generationRef.current) return false;
            if (!response.ok) {
              setOperationStatus(
                response.errors[0]?.message ??
                  "The relationship could not be archived.",
              );
              return false;
            }
            return Boolean(response.data.archiveRelationship?.relationship);
          }
        : undefined,
    };
  }, [mayArchive, mayCreate, mayUpdate, workspaceIdentity]);

  let liveMessage = operationStatus;
  if (!liveMessage && path) {
    liveMessage = `Path contains ${path.nodes.length} people and ${path.edges.length} ${path.edges.length === 1 ? "relationship" : "relationships"}.`;
  } else if (!liveMessage && pathMode && pathEndpoints.length === 1) {
    liveMessage = "First path person selected. Choose one more visible person.";
  } else if (!liveMessage && normalizedFilter) {
    liveMessage = `Showing ${visibleNodeIds.size} of ${result.nodes.length} loaded people and ${visibleEdgeIds.size} of ${result.edges.length} loaded relationships.`;
  } else if (!liveMessage) {
    liveMessage = `${result.nodes.length} people and ${result.edges.length} relationships loaded.`;
  }

  function select(
    selection: Exclude<GraphSelection, null>,
    initiator?: HTMLElement,
  ) {
    setSelected(selection);
    setOperationStatus("");
    if (initiator) inspectorFocusRef.current = initiator;
    if (!pathMode || selection.kind !== "node") return;
    if (!visibleNodeIds.has(selection.id)) return;
    if (pathEndpoints.length === 0 || pathEndpoints.length >= 2) {
      setPathEndpoints([selection.id]);
      setPath(null);
      return;
    }
    if (pathEndpoints[0] === selection.id) return;
    const found = shortestGraphPath(
      {
        ...result,
        nodes: result.nodes.filter((node) => visibleNodeIds.has(node.id)),
        edges: result.edges.filter((edge) => visibleEdgeIds.has(edge.id)),
      },
      pathEndpoints[0]!,
      selection.id,
      "NATURAL",
    );
    setPathEndpoints([pathEndpoints[0]!, selection.id]);
    setPath(found);
    if (!found)
      setOperationStatus(
        "No natural-direction path is present in the loaded graph.",
      );
  }

  function runCommand(type: GraphRendererCommand["type"]) {
    if (type === "circle") setLayoutAlgorithm("CIRCLE");
    if (type === "layout-start") setLayoutAlgorithm("FORCE_ATLAS_2");
    setRendererCommand((previous) => command(previous, type));
  }

  async function applyGeneratedFilter(nextFilter: GraphFilterInput) {
    const generation = generationRef.current;
    setOperationStatus("Loading the filtered authorized graph.");
    try {
      const nextResult = await queryAdapter(nextFilter);
      if (generation !== generationRef.current) return;
      setResult(nextResult);
      setPositions(
        deterministicCirclePositions(nextResult.nodes.map((node) => node.id)),
      );
      setSelected(null);
      setPath(null);
      setPathEndpoints([]);
      setSavedViewId(null);
      setOperationStatus(
        `${nextResult.nodes.length} people and ${nextResult.edges.length} relationships loaded from the generated filter.`,
      );
    } catch (error) {
      if (generation === generationRef.current) {
        setOperationStatus(
          error instanceof Error
            ? error.message
            : "The generated graph filter could not be applied.",
        );
      }
    }
  }

  function captureView() {
    return {
      filter: graphViewFilter(result.normalizedFilter),
      layout: {
        algorithm: layoutAlgorithm,
        settings: {
          barnesHutOptimize:
            layoutAlgorithm === "FORCE_ATLAS_2" && result.nodes.length >= 1_000,
          gravity: 1,
          scalingRatio: 1,
          slowDown: 1,
        },
      },
      appearance: { palette: "DEFAULT" as const, showLabels: true },
      positions: positions.map(({ id, x, y }) => ({ id, x, y })),
    };
  }

  function acceptSavedView(loaded: GraphSavedViewRun) {
    setResult(loaded.result);
    setPositions(
      loaded.positions?.length
        ? loaded.positions
        : deterministicCirclePositions(
            loaded.result.nodes.map((node) => node.id),
          ),
    );
    setLayoutAlgorithm(loaded.layoutAlgorithm ?? "CIRCLE");
    setSavedViewId(loaded.view.id);
    setSelected(null);
    setPath(null);
    setPathEndpoints([]);
  }

  function acceptAnalysisGraph(nextResult: GraphResult) {
    setResult(nextResult);
    setPositions(
      deterministicCirclePositions(nextResult.nodes.map((node) => node.id)),
    );
    setSelected(null);
    setPath(null);
    setPathEndpoints([]);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Social graph
          </h1>
          <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-6">
            Explore the authorized people and relationships loaded for this
            view. Counts describe this returned graph, not the entire workspace.
          </p>
        </div>
        <div className="text-muted-foreground text-right text-xs">
          <p>{result.nodes.length} people loaded</p>
          <p>{result.edges.length} relationships loaded</p>
        </div>
      </header>

      {result.limits.nodesTruncated || result.limits.edgesTruncated ? (
        <section
          className="border-disputed/50 bg-disputed/10 rounded-xl border px-4 py-3 text-sm"
          aria-label="Graph result limits"
        >
          <p className="font-semibold">This loaded graph is truncated</p>
          <p className="mt-1">
            The authorized query reached a configured node or relationship
            limit. Tables and exports contain every returned element.
          </p>
          {result.limits.reasons.length ? (
            <ul className="mt-2 list-disc pl-5">
              {result.limits.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {initialPositionsTruncated ? (
        <section
          className="border-disputed/50 bg-disputed/10 rounded-xl border px-4 py-3 text-sm"
          aria-label="Saved position page limit"
        >
          <p className="font-semibold">Saved positions are partially loaded</p>
          <p className="mt-1">
            The deep link restored the first 250 positions. Run the saved view
            below to load additional position pages explicitly.
          </p>
        </section>
      ) : null}

      <section
        aria-label="Graph controls"
        className="border-border bg-card rounded-2xl border p-4 shadow-sm"
      >
        <div className="grid gap-3 xl:grid-cols-[minmax(15rem,1fr)_auto] xl:items-center">
          <div>
            <label
              htmlFor="loaded-people-filter"
              className="text-sm font-semibold"
            >
              Filter loaded people
            </label>
            <Input
              id="loaded-people-filter"
              className="mt-2"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setSelected(null);
                setPath(null);
                setPathEndpoints([]);
                setOperationStatus("");
              }}
              placeholder="Match a loaded display name"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Zoom in"
              onClick={() => runCommand("zoom-in")}
            >
              <ZoomIn aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Zoom out"
              onClick={() => runCommand("zoom-out")}
            >
              <ZoomOut aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Fit graph"
              onClick={() => runCommand("fit")}
            >
              <Focus aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => runCommand("circle")}
            >
              <CircleDot aria-hidden="true" data-icon="inline-start" />
              Circle
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-label={
                layoutRunning
                  ? "Stop ForceAtlas2 layout"
                  : "Run ForceAtlas2 layout"
              }
              onClick={() =>
                runCommand(layoutRunning ? "layout-stop" : "layout-start")
              }
            >
              {layoutRunning ? (
                <Pause aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {layoutRunning ? "Stop layout" : "Run layout"}
            </Button>
            <Button
              type="button"
              variant={pathMode ? "secondary" : "outline"}
              aria-label={pathMode ? "Stop path mode" : "Start path mode"}
              aria-pressed={pathMode}
              onClick={() => {
                setPathMode((value) => !value);
                setPathEndpoints([]);
                setPath(null);
                setOperationStatus("");
              }}
            >
              <Link2 aria-hidden="true" data-icon="inline-start" />
              Path
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                document
                  .getElementById("graph-tables")
                  ?.scrollIntoView({ block: "start" })
              }
            >
              <TableProperties aria-hidden="true" data-icon="inline-start" />
              Tables
            </Button>
            {mayEdit ? (
              <Button
                type="button"
                variant="outline"
                aria-label="Edit selected neighborhood"
                disabled={!selectedNodeId}
                onClick={() => setEditorOpen(true)}
              >
                <Network aria-hidden="true" data-icon="inline-start" />
                Edit neighborhood
              </Button>
            ) : null}
            <GraphExportMenu
              result={result}
              positions={positions}
              onStatus={setOperationStatus}
            />
          </div>
        </div>
        <p
          role="status"
          aria-label="Graph explorer status"
          aria-live="polite"
          className="text-muted-foreground mt-3 min-h-5 text-xs"
        >
          {liveMessage}
        </p>
        <GraphFilterControls
          key={`${workspaceIdentity}:${result.fingerprint}`}
          catalogTruncated={relationshipTypesTruncated}
          result={result}
          relationshipTypes={relationshipTypes}
          onApply={applyGeneratedFilter}
        />
      </section>

      {effectiveSavedViewAdapter || effectiveAnalysisAdapter ? (
        <div className="grid gap-6 xl:grid-cols-2">
          {effectiveSavedViewAdapter ? (
            <GraphSavedViews
              key={`saved-views:${workspaceIdentity}`}
              adapter={effectiveSavedViewAdapter}
              canArchive={canArchiveViews}
              canCreate={canSaveViews}
              canUpdate={canUpdateViews}
              capture={captureView}
              initialView={initialSavedView}
              initialViewId={initialViewId}
              onRun={acceptSavedView}
              onStatus={setOperationStatus}
              workspaceIdentity={workspaceIdentity}
            />
          ) : null}
          {effectiveAnalysisAdapter ? (
            <GraphAnalysis
              key={`analysis:${workspaceIdentity}`}
              adapter={effectiveAnalysisAdapter}
              canRun={canRunAnalysis}
              currentFilter={graphViewFilter(result.normalizedFilter)}
              currentViewId={savedViewId}
              onGraph={acceptAnalysisGraph}
              onStatus={setOperationStatus}
              result={result}
              workspaceIdentity={workspaceIdentity}
            />
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="lg:col-span-2 lg:row-start-2">
          <GraphTable
            result={result}
            selected={selected}
            visibleEdgeIds={normalizedFilter ? visibleEdgeIds : undefined}
            visibleNodeIds={normalizedFilter ? visibleNodeIds : undefined}
            onSelect={select}
          />
        </div>
        {selected ? (
          <div className="lg:col-start-2 lg:row-start-1">
            <GraphInspector
              closeFocusRef={inspectorFocusRef as RefObject<HTMLElement | null>}
              result={result}
              selection={selected}
              onClose={() => setSelected(null)}
            />
          </div>
        ) : null}
        <div className="lg:col-start-1 lg:row-start-1">
          <GraphRenderer
            key={`renderer:${workspaceIdentity}`}
            command={rendererCommand}
            fallbackPositions={positions}
            initialPositions={positions}
            onLayoutStateChange={(running, message) => {
              setLayoutRunning(running);
              setOperationStatus(message);
            }}
            onSelect={(selection) => select(selection)}
            onPositionsChange={setPositions}
            pathEdgeIds={pathEdgeIds}
            pathNodeIds={pathNodeIds}
            result={result}
            selected={selected}
            visibleEdgeIds={visibleEdgeIds}
            visibleNodeIds={visibleNodeIds}
          />
          <div
            className="text-muted-foreground mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs"
            aria-label="Graph legend"
          >
            <span>
              <span aria-hidden="true">→</span> Directed relationship
            </span>
            <span>
              <span aria-hidden="true">—</span> Undirected relationship
            </span>
            <span>Outlined label: selected or path state</span>
          </div>
        </div>
      </div>

      {editorOpen && selectedNodeId ? (
        <RelationshipEditor
          focusId={selectedNodeId}
          mutationAdapter={mutationAdapter}
          relationshipTypes={relationshipTypes}
          relationshipTypesTruncated={relationshipTypesTruncated}
          result={result}
          onClose={() => setEditorOpen(false)}
          onMutationComplete={() => {
            setEditorOpen(false);
            window.location.reload();
          }}
        />
      ) : null}
    </div>
  );
}
