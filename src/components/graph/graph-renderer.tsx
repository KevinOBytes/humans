"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import type { GraphPosition, GraphResult } from "@/modules/graph/types";

import { GraphCanvasFallback } from "./graph-canvas-fallback";
import type { GraphSelection } from "./graph-table";

export type GraphVisualMode = "sigma" | "canvas" | "table";

export type GraphRendererCommand = {
  id: number;
  type:
    "circle" | "fit" | "layout-start" | "layout-stop" | "zoom-in" | "zoom-out";
};

export function chooseGraphVisualMode(input: {
  contextLosses: number;
  edgeCount: number;
  nodeCount: number;
  webglAvailable: boolean;
}): GraphVisualMode {
  if (input.contextLosses >= 2) return "table";
  if (input.webglAvailable) return "sigma";
  if (input.nodeCount <= 2_000 && input.edgeCount <= 5_000) return "canvas";
  return "table";
}

export function canRetryGraphWebGL(contextLosses: number): boolean {
  return contextLosses === 1;
}

export function detectWebGL() {
  if (
    typeof document === "undefined" ||
    typeof WebGLRenderingContext === "undefined"
  ) {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const loadSigmaRenderer = () =>
  import("./graph-sigma-renderer").then((module) => module.GraphSigmaRenderer);

if (
  typeof window !== "undefined" &&
  typeof globalThis.WebGLRenderingContext !== "undefined" &&
  typeof globalThis.WebGL2RenderingContext !== "undefined" &&
  !globalThis.navigator?.userAgent.toLowerCase().includes("jsdom")
) {
  void loadSigmaRenderer();
}

const SigmaRenderer = dynamic(loadSigmaRenderer, {
  loading: () => (
    <div className="bg-muted grid min-h-[32rem] place-items-center rounded-xl text-sm">
      Loading visual graph…
    </div>
  ),
  ssr: false,
});

export type GraphRendererProps = {
  command?: GraphRendererCommand;
  fallbackPositions?: readonly GraphPosition[];
  initialPositions?: readonly GraphPosition[];
  onLayoutStateChange?: (running: boolean, message: string) => void;
  onPositionsChange?: (positions: readonly GraphPosition[]) => void;
  onSelect: (selection: Exclude<GraphSelection, null>) => void;
  pathEdgeIds: ReadonlySet<string>;
  pathNodeIds: ReadonlySet<string>;
  result: GraphResult;
  selected: GraphSelection;
  visibleEdgeIds: ReadonlySet<string>;
  visibleNodeIds: ReadonlySet<string>;
};

export function GraphRenderer(props: GraphRendererProps) {
  const [webglAvailable, setWebglAvailable] = useState<boolean | null>(null);
  const [contextLosses, setContextLosses] = useState(0);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setWebglAvailable(detectWebGL());
    });
    return () => {
      active = false;
    };
  }, []);

  if (webglAvailable === null) {
    return (
      <div className="border-border bg-card rounded-2xl border p-4">
        <p className="text-muted-foreground text-sm">
          Checking visual graph support. Use the tables below for complete
          keyboard and screen-reader access.
        </p>
        <div className="bg-muted mt-3 min-h-[32rem] animate-pulse rounded-xl motion-reduce:animate-none" />
      </div>
    );
  }

  const mode = chooseGraphVisualMode({
    webglAvailable,
    contextLosses,
    nodeCount: props.result.nodes.length,
    edgeCount: props.result.edges.length,
  });
  return (
    <section
      aria-labelledby="visual-graph-heading"
      className="border-border bg-card rounded-2xl border p-4 shadow-sm"
    >
      <div className="mb-3">
        <h2 id="visual-graph-heading" className="font-semibold">
          Visual graph
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Pan and zoom the visual when available. It is not the accessibility
          equivalent; every loaded item remains available in the tables below.
        </p>
        {props.result.nodes.length > 2_000 ||
        props.result.edges.length > 5_000 ? (
          <p className="text-muted-foreground mt-1 text-xs">
            Large graphs first render a deterministic relationship-preserving
            preview and temporarily simplify visual detail during camera motion.
            The complete loaded visual is restored after each transition.
          </p>
        ) : null}
      </div>
      {mode === "sigma" ? (
        <SigmaRenderer
          {...props}
          onContextLost={() => {
            setContextLosses((value) => value + 1);
            setWebglAvailable(false);
          }}
        />
      ) : mode === "canvas" ? (
        <>
          <GraphCanvasFallback
            positions={props.fallbackPositions ?? props.initialPositions}
            result={props.result}
            visibleEdgeIds={props.visibleEdgeIds}
            visibleNodeIds={props.visibleNodeIds}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              WebGL is unavailable. Showing a read-only Canvas 2D image.
            </p>
            <button
              type="button"
              className="focus-visible:ring-ring min-h-11 rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => setWebglAvailable(detectWebGL())}
            >
              Retry WebGL
            </button>
          </div>
        </>
      ) : (
        <div className="border-border bg-muted rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-semibold">Visual graph unavailable</p>
          <p className="text-muted-foreground mx-auto mt-2 max-w-xl text-sm">
            This loaded result is above the safe Canvas 2D limit, or WebGL was
            lost repeatedly. No data was removed; use the complete tables and
            export controls.
          </p>
          {canRetryGraphWebGL(contextLosses) ? (
            <button
              type="button"
              className="focus-visible:ring-ring mt-5 min-h-11 rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => setWebglAvailable(detectWebGL())}
            >
              Retry WebGL once
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
