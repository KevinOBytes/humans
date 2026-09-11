"use client";

import { useRouter } from "next/navigation";

import { GraphExplorer, type GraphExplorerProps } from "./graph-explorer";

export function GraphExplorerShell(props: GraphExplorerProps) {
  const router = useRouter();
  return <GraphExplorer {...props} onRefresh={() => router.refresh()} />;
}
