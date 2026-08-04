"use client";

import Link from "next/link";
import { useMemo, useState, type MouseEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { GraphResult } from "@/modules/graph/types";

export type GraphSelection =
  { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

export type GraphTableProps = {
  result: GraphResult;
  selected: GraphSelection;
  visibleEdgeIds?: ReadonlySet<string>;
  visibleNodeIds?: ReadonlySet<string>;
  onSelect: (
    selection: Exclude<GraphSelection, null>,
    initiator?: HTMLElement,
  ) => void;
};

const PAGE_SIZE = 50;

function pageCount(length: number) {
  return Math.max(1, Math.ceil(length / PAGE_SIZE));
}

function boundedPage(page: number, length: number) {
  return Math.min(page, pageCount(length) - 1);
}

function relationshipWhen(edge: GraphResult["edges"][number]) {
  if (edge.validFrom && edge.validUntil) {
    return `${edge.validFrom} to ${edge.validUntil}`;
  }
  if (edge.validFrom) return `From ${edge.validFrom}`;
  if (edge.validUntil) return `Until ${edge.validUntil}`;
  return `${edge.temporalSemantics}; ${edge.temporalPrecision} precision`;
}

function Pager({
  count,
  noun,
  page,
  setPage,
}: {
  count: number;
  noun: "people" | "relationships";
  page: number;
  setPage: (page: number) => void;
}) {
  const pages = pageCount(count);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="text-muted-foreground text-xs">
        Page {page + 1} of {pages}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
          aria-label={`Previous ${noun} page`}
        >
          Previous
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page + 1 >= pages}
          onClick={() => setPage(page + 1)}
          aria-label={`Next ${noun} page`}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function GraphTable({
  onSelect,
  result,
  selected,
  visibleEdgeIds,
  visibleNodeIds,
}: GraphTableProps) {
  const [nodePage, setNodePage] = useState(0);
  const [edgePage, setEdgePage] = useState(0);
  const nodes = useMemo(
    () =>
      visibleNodeIds
        ? result.nodes.filter((node) => visibleNodeIds.has(node.id))
        : result.nodes,
    [result.nodes, visibleNodeIds],
  );
  const edges = useMemo(
    () =>
      visibleEdgeIds
        ? result.edges.filter((edge) => visibleEdgeIds.has(edge.id))
        : result.edges,
    [result.edges, visibleEdgeIds],
  );
  const nodeNames = useMemo(
    () => new Map(result.nodes.map((node) => [node.id, node.displayName])),
    [result.nodes],
  );
  const currentNodePage = boundedPage(nodePage, nodes.length);
  const currentEdgePage = boundedPage(edgePage, edges.length);

  const select =
    (selection: Exclude<GraphSelection, null>) =>
    (event: MouseEvent<HTMLButtonElement>) => {
      onSelect(selection, event.currentTarget);
    };
  const shownNodes = nodes.slice(
    currentNodePage * PAGE_SIZE,
    (currentNodePage + 1) * PAGE_SIZE,
  );
  const shownEdges = edges.slice(
    currentEdgePage * PAGE_SIZE,
    (currentEdgePage + 1) * PAGE_SIZE,
  );

  return (
    <div className="grid gap-6" id="graph-tables">
      <section
        aria-labelledby="loaded-people-heading"
        className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm"
      >
        <div className="border-border border-b px-4 py-4">
          <h2 id="loaded-people-heading" className="font-semibold">
            Loaded people
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {nodes.length} loaded {nodes.length === 1 ? "person" : "people"}
            {visibleNodeIds ? " match the local filter" : " are available"}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table aria-label="Loaded people">
            <caption className="sr-only">Loaded people</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sensitivity</TableHead>
                <TableHead>Degree</TableHead>
                <TableHead>Community</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownNodes.map((node) => {
                const isSelected =
                  selected?.kind === "node" && selected.id === node.id;
                const metricNode = node as typeof node & {
                  community?: number | string | null;
                  degree?: number | null;
                };
                return (
                  <TableRow
                    key={node.id}
                    data-selected={isSelected || undefined}
                  >
                    <TableCell className="min-w-56">
                      <Link
                        className="focus-visible:outline-ring font-semibold underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2"
                        href={`/people/${node.id}`}
                      >
                        {node.displayName}
                      </Link>
                      <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                        {node.id}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral">{node.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral">{node.sensitivity}</Badge>
                    </TableCell>
                    <TableCell>
                      {metricNode.degree ?? "Not calculated"}
                    </TableCell>
                    <TableCell>
                      {metricNode.community ?? "Not calculated"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant={isSelected ? "secondary" : "outline"}
                        aria-current={isSelected ? "true" : undefined}
                        aria-label={`Details for ${node.displayName}${isSelected ? ", selected" : ""}`}
                        onClick={select({ kind: "node", id: node.id })}
                      >
                        {isSelected ? "Selected" : "Inspect"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shownNodes.length === 0 ? (
                <TableRow>
                  <td
                    className="text-muted-foreground px-4 py-8 text-center"
                    colSpan={6}
                  >
                    No loaded people match the local filter.
                  </td>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <Pager
          count={nodes.length}
          noun="people"
          page={currentNodePage}
          setPage={setNodePage}
        />
      </section>

      <section
        aria-labelledby="loaded-relationships-heading"
        className="border-border bg-card overflow-hidden rounded-2xl border shadow-sm"
      >
        <div className="border-border border-b px-4 py-4">
          <h2 id="loaded-relationships-heading" className="font-semibold">
            Loaded relationships
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {edges.length} loaded{" "}
            {edges.length === 1 ? "relationship" : "relationships"}
            {visibleEdgeIds ? " match the local filter" : " are available"}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table aria-label="Loaded relationships">
            <caption className="sr-only">Loaded relationships</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Relationship and direction</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownEdges.map((edge) => {
                const isSelected =
                  selected?.kind === "edge" && selected.id === edge.id;
                return (
                  <TableRow
                    key={edge.id}
                    data-selected={isSelected || undefined}
                  >
                    <TableCell>
                      {nodeNames.get(edge.source) ?? edge.source}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">
                        {edge.forwardLabel} (
                        {edge.directed ? "directed" : "undirected"})
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {edge.directed
                          ? "Source to target"
                          : "Connects both ways"}
                      </p>
                    </TableCell>
                    <TableCell>
                      {nodeNames.get(edge.target) ?? edge.target}
                    </TableCell>
                    <TableCell>
                      <Badge variant="neutral">{edge.state}</Badge>
                    </TableCell>
                    <TableCell>{Math.round(edge.confidence * 100)}%</TableCell>
                    <TableCell className="min-w-48 text-xs">
                      {relationshipWhen(edge)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant={isSelected ? "secondary" : "outline"}
                        aria-current={isSelected ? "true" : undefined}
                        aria-label={`Details for ${edge.forwardLabel} relationship${isSelected ? ", selected" : ""}`}
                        onClick={select({ kind: "edge", id: edge.id })}
                      >
                        {isSelected ? "Selected" : "Inspect"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shownEdges.length === 0 ? (
                <TableRow>
                  <td
                    className="text-muted-foreground px-4 py-8 text-center"
                    colSpan={7}
                  >
                    No loaded relationships match the local filter.
                  </td>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <Pager
          count={edges.length}
          noun="relationships"
          page={currentEdgePage}
          setPage={setEdgePage}
        />
      </section>
    </div>
  );
}
