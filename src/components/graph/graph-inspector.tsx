"use client";

import Link from "next/link";
import type { RefObject } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GraphResult } from "@/modules/graph/types";

import type { GraphSelection } from "./graph-table";
import { relationshipStateStyle } from "./relationship-state-style";

export function GraphInspector({
  closeFocusRef,
  onClose,
  result,
  selection,
}: {
  closeFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  result: GraphResult;
  selection: Exclude<GraphSelection, null>;
}) {
  const node =
    selection.kind === "node"
      ? result.nodes.find((candidate) => candidate.id === selection.id)
      : undefined;
  const edge =
    selection.kind === "edge"
      ? result.edges.find((candidate) => candidate.id === selection.id)
      : undefined;
  if (!node && !edge) return null;
  const nodeNames = new Map(
    result.nodes.map((candidate) => [candidate.id, candidate.displayName]),
  );
  const heading = node?.displayName ?? edge?.forwardLabel ?? "Graph selection";

  function close() {
    onClose();
    closeFocusRef?.current?.focus();
  }

  return (
    <aside
      aria-labelledby="graph-inspector-heading"
      className="border-border bg-card rounded-2xl border p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            {node ? "Person" : "Relationship"}
          </p>
          <h2
            id="graph-inspector-heading"
            className="mt-1 text-lg font-semibold break-words"
          >
            {heading}
          </h2>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Close inspector"
          onClick={close}
        >
          Close
        </Button>
      </div>
      {node ? (
        <>
          <dl className="mt-5 grid gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground text-xs">Status</dt>
              <dd className="mt-1">
                <Badge variant="neutral">{node.status}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Sensitivity</dt>
              <dd className="mt-1">
                <Badge variant="neutral">{node.sensitivity}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Record version</dt>
              <dd className="mt-1">{node.version}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Person ID</dt>
              <dd className="mt-1 font-mono text-xs break-all">{node.id}</dd>
            </div>
          </dl>
          <Link
            className="text-primary focus-visible:ring-ring mt-6 inline-flex min-h-11 items-center rounded-xl text-sm font-semibold underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
            href={`/people/${node.id}`}
          >
            Open person record
          </Link>
        </>
      ) : edge ? (
        <dl className="mt-5 grid gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Connection</dt>
            <dd className="mt-1">
              {nodeNames.get(edge.source) ?? edge.source}{" "}
              {edge.directed ? "to" : "and"}{" "}
              {nodeNames.get(edge.target) ?? edge.target}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Direction</dt>
            <dd className="mt-1">
              {edge.directed
                ? "Directed, source to target"
                : "Undirected, both ways"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">
              State and sensitivity
            </dt>
            <dd className="mt-1 flex flex-wrap gap-2">
              <Badge
                variant="neutral"
                style={{
                  borderColor: relationshipStateStyle[edge.state].stroke,
                }}
              >
                {edge.state}
              </Badge>
              <Badge variant="neutral">{edge.sensitivity}</Badge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Confidence</dt>
            <dd className="mt-1">{Math.round(edge.confidence * 100)}%</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Relationship ID</dt>
            <dd className="mt-1 font-mono text-xs break-all">
              {edge.relationshipId}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Temporal interval</dt>
            <dd>
              {edge.validFrom ?? "Unknown start"} —{" "}
              {edge.validUntil ?? "Unknown end"} ({edge.temporalPrecision})
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">
              Evidence and case scope
            </dt>
            <dd>
              Source count is not available in this graph projection. Case
              membership is not established by this view.
            </dd>
          </div>
          {edge.state === "inferred" || edge.state === "disputed" ? (
            <div>
              <dd>
                Promotion requires evidence review; confidence alone does not
                establish a fact.
              </dd>
              <Link
                href={`/people/${edge.source}?view=relationships`}
                className="text-primary underline"
              >
                Open relationship evidence
              </Link>
            </div>
          ) : null}
        </dl>
      ) : null}
    </aside>
  );
}
