"use client";

import {
  SigmaContainer,
  useCamera,
  useRegisterEvents,
  useSigma,
} from "@react-sigma/core";
import { useWorkerLayoutForceAtlas2 } from "@react-sigma/layout-forceatlas2";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { EdgeArrowProgram, EdgeLineProgram } from "sigma/rendering";

import {
  deterministicCirclePositions,
  toGraphologyGraph,
} from "@/modules/graph/transform";
import type { GraphPosition, GraphResult } from "@/modules/graph/types";

import type { GraphRendererProps } from "./graph-renderer";
import {
  forceAtlasParameters,
  initialPreviewNodeIds,
  motionDetailNodeIds,
  shouldHideGraphEdge,
  shouldHideGraphNode,
  shouldRunAnimatedLayout,
} from "./graph-renderer-state";

const SENSITIVITY_COLORS: Record<string, string> = {
  public: "#0ea5e9",
  internal: "#2563eb",
  confidential: "#7c3aed",
  restricted: "#be123c",
};

const SIGMA_SETTINGS = {
  allowInvalidContainer: false,
  defaultEdgeColor: "#64748b",
  defaultEdgeType: "line",
  defaultNodeColor: "#2563eb",
  edgeProgramClasses: {
    arrow: EdgeArrowProgram,
    line: EdgeLineProgram,
  },
  enableEdgeEvents: true,
  hideEdgesOnMove: false,
  hideLabelsOnMove: false,
  labelDensity: 0.8,
  labelGridCellSize: 120,
  labelRenderedSizeThreshold: 8,
  renderEdgeLabels: false,
  renderLabels: true,
  stagePadding: 48,
  zIndex: true,
} as const;

type GraphPerformanceProbe = {
  camera: { angle: number; ratio: number; x: number; y: number };
  firstVisualEdgeCount?: number;
  firstVisualNodeCount?: number;
  fullDetailRestoredAt?: number;
  lastFrameAt: number;
  motionDetailActive: boolean;
  motionDetailSampledAt?: number;
  motionDetailStartedAt?: number;
  motionInputStartedAt?: number;
  rendererFrames: number;
  visualEdgeCount: number;
  visualNodeCount: number;
};

type PerformanceGlobal = typeof globalThis & {
  __HUMANS_GRAPH_PERFORMANCE_DRIVER__?: (input: {
    duration: number;
    ratioFactor: number;
    xDelta: number;
    yDelta: number;
  }) => void;
  __HUMANS_GRAPH_PERFORMANCE__?: GraphPerformanceProbe;
};

function prepareGraph(
  result: GraphResult,
  positions?: readonly GraphPosition[],
) {
  globalThis.performance?.mark("humans:graph-transform-start");
  const graph = toGraphologyGraph(result, positions);
  graph.forEachNode((node, attributes) => {
    graph.mergeNodeAttributes(node, {
      color: SENSITIVITY_COLORS[String(attributes.sensitivity)] ?? "#2563eb",
      label: String(attributes.label ?? node),
      size: 7,
      type: "circle",
      zIndex: 1,
    });
  });
  graph.forEachEdge((edge, attributes) => {
    graph.mergeEdgeAttributes(edge, {
      color: "#64748b",
      size:
        typeof attributes.strength === "number"
          ? 1 + Math.max(0, Math.min(1, attributes.strength)) * 2
          : 1.5,
      type: attributes.directed ? "arrow" : "line",
      zIndex: 0,
    });
  });
  globalThis.performance?.mark("humans:graph-transform-end");
  return graph;
}

function SigmaController({
  command,
  onContextLost,
  onLayoutStateChange,
  onPositionsChange,
  onSelect,
  pathEdgeIds,
  pathNodeIds,
  result,
  selected,
  visibleEdgeIds,
  visibleNodeIds,
  fullGraph,
  renderGraph,
}: GraphRendererProps & {
  fullGraph: ReturnType<typeof prepareGraph>;
  onContextLost: () => void;
  renderGraph: ReturnType<typeof prepareGraph>;
}) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const { reset, zoomIn, zoomOut } = useCamera({ duration: 180 });
  const { kill, start, stop } = useWorkerLayoutForceAtlas2(
    useMemo(
      () => forceAtlasParameters(result.nodes.length),
      [result.nodes.length],
    ),
  );
  const lastCommand = useRef(0);
  const layoutTimer = useRef<number | null>(null);
  const motionTimer = useRef<number | null>(null);
  const motionActive = useRef(false);
  const firstRenderMarked = useRef(false);
  const callbackRef = useRef({
    onContextLost,
    onLayoutStateChange,
    onPositionsChange,
    onSelect,
  });
  useLayoutEffect(() => {
    if (sigma.getGraph() !== renderGraph) sigma.setGraph(renderGraph);
  }, [renderGraph, sigma]);
  useEffect(() => {
    sigma.setSettings({
      hideEdgesOnMove: result.edges.length > 10_000,
      hideLabelsOnMove: result.nodes.length > 2_000,
    });
  }, [result.edges.length, result.nodes.length, sigma]);
  useEffect(() => {
    callbackRef.current = {
      onContextLost,
      onLayoutStateChange,
      onPositionsChange,
      onSelect,
    };
  }, [onContextLost, onLayoutStateChange, onPositionsChange, onSelect]);
  const capturePositions = useCallback(
    () =>
      callbackRef.current.onPositionsChange?.(
        fullGraph
          .nodes()
          .sort()
          .map((id) => ({
            id,
            x: Number(fullGraph.getNodeAttribute(id, "x")),
            y: Number(fullGraph.getNodeAttribute(id, "y")),
          })),
      ),
    [fullGraph],
  );
  const largeMotionGraph =
    result.nodes.length > 2_000 || result.edges.length > 5_000;
  const requiresVisualReducers =
    selected !== null ||
    pathNodeIds.size > 0 ||
    pathEdgeIds.size > 0 ||
    visibleNodeIds.size !== result.nodes.length ||
    visibleEdgeIds.size !== result.edges.length;
  const motionNodeIds = useMemo(
    () =>
      motionDetailNodeIds({
        nodeIds: result.nodes.map((node) => node.id),
        pathNodeIds,
        selectedNodeId: selected?.kind === "node" ? selected.id : undefined,
      }),
    [pathNodeIds, result.nodes, selected],
  );
  const motionGraphRef = useRef<{
    fullGraph: typeof fullGraph;
    graph: typeof fullGraph;
    nodeIds: ReadonlySet<string>;
  } | null>(null);
  const getMotionGraph = useCallback(() => {
    const current = motionGraphRef.current;
    if (current?.fullGraph === fullGraph && current.nodeIds === motionNodeIds) {
      return current.graph;
    }
    const graph = fullGraph.copy();
    graph.clearEdges();
    for (const node of graph.nodes()) {
      if (!motionNodeIds.has(node)) graph.dropNode(node);
    }
    motionGraphRef.current = { fullGraph, graph, nodeIds: motionNodeIds };
    return graph;
  }, [fullGraph, motionNodeIds]);
  const applyVisualReducers = useCallback(() => {
    if (process.env.NEXT_PUBLIC_GRAPH_PERFORMANCE_INSTRUMENTATION === "1") {
      const motionDetailActive = motionActive.current;
      sigma.once("afterRender", () => {
        const graph = sigma.getGraph();
        let visualNodeCount = 0;
        let visualEdgeCount = 0;
        graph.forEachNode((node) => {
          if (!sigma.getNodeDisplayData(node)?.hidden) visualNodeCount += 1;
        });
        graph.forEachEdge((edge) => {
          if (!sigma.getEdgeDisplayData(edge)?.hidden) visualEdgeCount += 1;
        });
        const performanceGlobal = globalThis as PerformanceGlobal;
        const previous = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__;
        if (previous) {
          performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__ = {
            ...previous,
            motionDetailActive,
            ...(motionDetailActive &&
            previous.motionDetailSampledAt === undefined
              ? { motionDetailSampledAt: performance.now() }
              : {}),
            visualEdgeCount,
            visualNodeCount,
          };
        }
      });
    }
    if (!requiresVisualReducers) {
      if (sigma.getSetting("nodeReducer") !== null) {
        sigma.setSetting("nodeReducer", null);
      }
      if (sigma.getSetting("edgeReducer") !== null) {
        sigma.setSetting("edgeReducer", null);
      }
      sigma.refresh();
      return;
    }
    sigma.setSetting("nodeReducer", (node, data) => {
      const pathMember = pathNodeIds.has(node);
      const active = selected?.kind === "node" && selected.id === node;
      return {
        ...data,
        color: active ? "#db2777" : pathMember ? "#7c3aed" : data.color,
        forceLabel: active || pathMember,
        hidden: shouldHideGraphNode({
          inMotionDetail: motionNodeIds.has(node),
          largeMotionGraph,
          motionDetailActive: motionActive.current,
          visible: visibleNodeIds.has(node),
        }),
        highlighted: active || pathMember,
        size: active ? 11 : pathMember ? 9 : data.size,
        zIndex: active || pathMember ? 3 : 1,
      };
    });
    sigma.setSetting("edgeReducer", (edge, data) => {
      const pathMember = pathEdgeIds.has(edge);
      const active = selected?.kind === "edge" && selected.id === edge;
      return {
        ...data,
        color: active ? "#db2777" : pathMember ? "#7c3aed" : data.color,
        hidden: shouldHideGraphEdge({
          largeMotionGraph,
          motionDetailActive: motionActive.current,
          visible: visibleEdgeIds.has(edge),
        }),
        size: active ? 4 : pathMember ? 3 : data.size,
        zIndex: active || pathMember ? 2 : 0,
      };
    });
    sigma.refresh();
  }, [
    largeMotionGraph,
    motionNodeIds,
    pathEdgeIds,
    pathNodeIds,
    requiresVisualReducers,
    selected,
    sigma,
    visibleEdgeIds,
    visibleNodeIds,
  ]);

  const startMotionDetail = useCallback(() => {
    if (!largeMotionGraph || motionActive.current) return;
    motionActive.current = true;
    const motionGraph = getMotionGraph();
    if (sigma.getGraph() !== motionGraph) sigma.setGraph(motionGraph);
    applyVisualReducers();
    if (process.env.NEXT_PUBLIC_GRAPH_PERFORMANCE_INSTRUMENTATION === "1") {
      const performanceGlobal = globalThis as PerformanceGlobal;
      const previous = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__;
      if (previous) {
        performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__ = {
          ...previous,
          motionDetailActive: true,
          motionDetailStartedAt: performance.now(),
        };
      }
    }
  }, [applyVisualReducers, getMotionGraph, largeMotionGraph, sigma]);
  const restoreFullDetail = useCallback(() => {
    if (motionTimer.current !== null) {
      window.clearTimeout(motionTimer.current);
      motionTimer.current = null;
    }
    const wasActive = motionActive.current;
    motionActive.current = false;
    if (sigma.getGraph() !== fullGraph) sigma.setGraph(fullGraph);
    if (wasActive) applyVisualReducers();
  }, [applyVisualReducers, fullGraph, sigma]);

  useEffect(() => {
    registerEvents({
      clickEdge: ({ edge }) =>
        callbackRef.current.onSelect({ kind: "edge", id: edge }),
      clickNode: ({ node }) =>
        callbackRef.current.onSelect({ kind: "node", id: node }),
    });
  }, [registerEvents]);

  useEffect(() => {
    firstRenderMarked.current = false;
    let restoreFrame: number | null = null;
    const markFullDetail = () => {
      globalThis.performance?.mark("humans:graph-sigma-full-detail-render");
      if (process.env.NEXT_PUBLIC_GRAPH_PERFORMANCE_INSTRUMENTATION !== "1") {
        return;
      }
      const performanceGlobal = globalThis as PerformanceGlobal;
      const previous = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__;
      if (previous) {
        performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__ = {
          ...previous,
          fullDetailRestoredAt: performance.now(),
          motionDetailActive: false,
          visualEdgeCount: fullGraph.size,
          visualNodeCount: fullGraph.order,
        };
      }
    };
    const markFirstRender = () => {
      if (firstRenderMarked.current) return;
      firstRenderMarked.current = true;
      globalThis.performance?.mark("humans:graph-sigma-first-render");
      const renderedGraph = sigma.getGraph();
      if (process.env.NEXT_PUBLIC_GRAPH_PERFORMANCE_INSTRUMENTATION === "1") {
        const performanceGlobal = globalThis as PerformanceGlobal;
        const previous = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__;
        const camera = sigma.getCamera().getState();
        performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__ = {
          ...previous,
          camera: {
            angle: camera.angle,
            ratio: camera.ratio,
            x: camera.x,
            y: camera.y,
          },
          firstVisualEdgeCount: renderedGraph.size,
          firstVisualNodeCount: renderedGraph.order,
          lastFrameAt: performance.now(),
          motionDetailActive: false,
          rendererFrames: previous?.rendererFrames ?? 0,
          visualEdgeCount: renderedGraph.size,
          visualNodeCount: renderedGraph.order,
        };
      }
      if (renderedGraph !== fullGraph) {
        restoreFrame = window.requestAnimationFrame(() => {
          sigma.once("afterRender", markFullDetail);
          sigma.setGraph(fullGraph);
          sigma.refresh();
        });
      }
    };
    sigma.on("afterRender", markFirstRender);
    sigma.refresh();
    return () => {
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
      sigma.off("afterRender", markFirstRender);
      sigma.off("afterRender", markFullDetail);
    };
  }, [fullGraph, sigma]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_GRAPH_PERFORMANCE_INSTRUMENTATION !== "1") {
      return;
    }
    const performanceGlobal = globalThis as PerformanceGlobal;
    const driveCamera = (input: {
      duration: number;
      ratioFactor: number;
      xDelta: number;
      yDelta: number;
    }) => {
      const camera = sigma.getCamera();
      const current = camera.getState();
      const previous = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__;
      if (previous) {
        performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__ = {
          ...previous,
          motionInputStartedAt: performance.now(),
        };
      }
      camera.animate(
        {
          ratio: current.ratio * input.ratioFactor,
          x: current.x + input.xDelta,
          y: current.y + input.yDelta,
        },
        { duration: input.duration },
      );
    };
    const recordFrame = () => {
      const camera = sigma.getCamera().getState();
      const previous = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__;
      performanceGlobal.__HUMANS_GRAPH_PERFORMANCE__ = {
        ...previous,
        camera: {
          angle: camera.angle,
          ratio: camera.ratio,
          x: camera.x,
          y: camera.y,
        },
        lastFrameAt: performance.now(),
        motionDetailActive: previous?.motionDetailActive ?? false,
        rendererFrames: (previous?.rendererFrames ?? 0) + 1,
        visualEdgeCount: previous?.visualEdgeCount ?? result.edges.length,
        visualNodeCount: previous?.visualNodeCount ?? result.nodes.length,
      };
    };
    performanceGlobal.__HUMANS_GRAPH_PERFORMANCE_DRIVER__ = driveCamera;
    sigma.on("afterRender", recordFrame);
    recordFrame();
    return () => {
      sigma.off("afterRender", recordFrame);
      if (
        performanceGlobal.__HUMANS_GRAPH_PERFORMANCE_DRIVER__ === driveCamera
      ) {
        delete performanceGlobal.__HUMANS_GRAPH_PERFORMANCE_DRIVER__;
      }
    };
  }, [result, sigma]);

  useEffect(() => {
    applyVisualReducers();
  }, [applyVisualReducers]);

  useEffect(() => {
    if (!largeMotionGraph) return;
    const camera = sigma.getCamera();
    const updated = () => {
      startMotionDetail();
      if (motionTimer.current !== null) {
        window.clearTimeout(motionTimer.current);
      }
      motionTimer.current = window.setTimeout(() => {
        restoreFullDetail();
      }, 220);
    };
    camera.on("updated", updated);
    return () => {
      camera.off("updated", updated);
      restoreFullDetail();
    };
  }, [largeMotionGraph, restoreFullDetail, sigma, startMotionDetail]);

  useEffect(() => {
    const canvases = Object.values(sigma.getCanvases());
    const lost = (event: Event) => {
      event.preventDefault();
      capturePositions();
      callbackRef.current.onContextLost();
    };
    canvases.forEach((canvas) =>
      canvas.addEventListener("webglcontextlost", lost),
    );
    return () =>
      canvases.forEach((canvas) =>
        canvas.removeEventListener("webglcontextlost", lost),
      );
  }, [capturePositions, sigma]);

  useEffect(() => {
    if (!command || command.id === lastCommand.current) return;
    lastCommand.current = command.id;
    restoreFullDetail();
    if (command.type === "zoom-in") zoomIn();
    if (command.type === "zoom-out") zoomOut();
    if (command.type === "fit") reset();
    if (command.type === "circle") {
      stop();
      const positions = deterministicCirclePositions(sigma.getGraph().nodes());
      for (const position of positions) {
        sigma.getGraph().mergeNodeAttributes(position.id, {
          x: position.x,
          y: position.y,
        });
      }
      sigma.refresh();
      reset();
      capturePositions();
      callbackRef.current.onLayoutStateChange?.(
        false,
        "Deterministic circle layout applied.",
      );
    }
    if (command.type === "layout-stop") {
      if (layoutTimer.current !== null)
        window.clearTimeout(layoutTimer.current);
      layoutTimer.current = null;
      stop();
      capturePositions();
      callbackRef.current.onLayoutStateChange?.(
        false,
        "ForceAtlas2 layout stopped.",
      );
    }
    if (command.type === "layout-start") {
      if (!shouldRunAnimatedLayout(window.matchMedia?.bind(window))) {
        callbackRef.current.onLayoutStateChange?.(
          false,
          "ForceAtlas2 was not started because reduced motion is enabled.",
        );
        return;
      }
      start();
      callbackRef.current.onLayoutStateChange?.(
        true,
        "ForceAtlas2 layout running.",
      );
      layoutTimer.current = window.setTimeout(() => {
        stop();
        layoutTimer.current = null;
        capturePositions();
        callbackRef.current.onLayoutStateChange?.(
          false,
          "ForceAtlas2 reached its 15 second limit and stopped.",
        );
      }, 15_000);
    }
  }, [
    capturePositions,
    command,
    reset,
    restoreFullDetail,
    sigma,
    start,
    stop,
    zoomIn,
    zoomOut,
  ]);

  useEffect(
    () => () => {
      if (layoutTimer.current !== null)
        window.clearTimeout(layoutTimer.current);
      kill();
    },
    [kill],
  );

  return null;
}

export function GraphSigmaRenderer(
  props: GraphRendererProps & { onContextLost: () => void },
) {
  const fullGraph = useMemo(
    () => prepareGraph(props.result, props.initialPositions),
    [props.initialPositions, props.result],
  );
  const graph = useMemo(() => {
    if (
      props.result.nodes.length <= 2_000 &&
      props.result.edges.length <= 5_000
    ) {
      return fullGraph;
    }
    const previewNodeIds = initialPreviewNodeIds({
      nodeIds: props.result.nodes.map(({ id }) => id),
      edges: props.result.edges,
    });
    const preview = fullGraph.copy();
    for (const node of preview.nodes()) {
      if (!previewNodeIds.has(node)) preview.dropNode(node);
    }
    return preview;
  }, [fullGraph, props.result.edges, props.result.nodes]);
  return (
    <SigmaContainer
      settings={SIGMA_SETTINGS}
      className="h-[32rem] w-full overflow-hidden rounded-xl"
      style={{ height: "32rem", width: "100%" }}
    >
      <SigmaController {...props} fullGraph={fullGraph} renderGraph={graph} />
    </SigmaContainer>
  );
}
