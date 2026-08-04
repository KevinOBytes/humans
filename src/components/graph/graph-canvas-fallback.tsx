"use client";

import { useEffect, useMemo, useRef } from "react";

import { deterministicCirclePositions } from "@/modules/graph/transform";
import type { GraphResult } from "@/modules/graph/types";
import type { GraphPosition } from "@/modules/graph/types";

export function GraphCanvasFallback({
  positions: suppliedPositions,
  result,
  visibleEdgeIds,
  visibleNodeIds,
}: {
  positions?: readonly GraphPosition[];
  result: GraphResult;
  visibleEdgeIds: ReadonlySet<string>;
  visibleNodeIds: ReadonlySet<string>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positions = useMemo(() => {
    const mapped = new Map(
      deterministicCirclePositions(result.nodes.map((node) => node.id)).map(
        ({ id, x, y }) => [id, { x, y }],
      ),
    );
    for (const position of suppliedPositions ?? []) {
      if (
        mapped.has(position.id) &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y)
      ) {
        mapped.set(position.id, { x: position.x, y: position.y });
      }
    }
    return mapped;
  }, [result.nodes, suppliedPositions]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(640, Math.floor(bounds.width || 960));
      const height = Math.max(420, Math.floor(bounds.height || 560));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const dark = document.documentElement.classList.contains("dark");
      context.fillStyle = dark ? "#1d2636" : "#f8fafc";
      context.fillRect(0, 0, width, height);
      const point = (id: string) => {
        const position = positions.get(id);
        return position
          ? {
              x: width / 2 + position.x * Math.max(90, width * 0.38),
              y: height / 2 + position.y * Math.max(90, height * 0.38),
            }
          : null;
      };

      context.strokeStyle = dark ? "#8ba0bd" : "#64748b";
      context.lineWidth = 1.5;
      for (const edge of result.edges) {
        if (!visibleEdgeIds.has(edge.id)) continue;
        const source = point(edge.source);
        const target = point(edge.target);
        if (!source || !target) continue;
        context.beginPath();
        if (edge.source === edge.target) {
          context.arc(source.x, source.y - 16, 16, 0, Math.PI * 2);
        } else {
          context.moveTo(source.x, source.y);
          context.lineTo(target.x, target.y);
        }
        context.stroke();
        if (edge.directed && edge.source !== edge.target) {
          const angle = Math.atan2(target.y - source.y, target.x - source.x);
          context.beginPath();
          context.moveTo(target.x, target.y);
          context.lineTo(
            target.x - 11 * Math.cos(angle - Math.PI / 6),
            target.y - 11 * Math.sin(angle - Math.PI / 6),
          );
          context.lineTo(
            target.x - 11 * Math.cos(angle + Math.PI / 6),
            target.y - 11 * Math.sin(angle + Math.PI / 6),
          );
          context.closePath();
          context.fillStyle = context.strokeStyle;
          context.fill();
        }
      }
      for (const node of result.nodes) {
        if (!visibleNodeIds.has(node.id)) continue;
        const current = point(node.id);
        if (!current) continue;
        context.beginPath();
        context.arc(current.x, current.y, 7, 0, Math.PI * 2);
        context.fillStyle = "#3b82f6";
        context.fill();
        context.strokeStyle = dark ? "#f8fafc" : "#0f172a";
        context.lineWidth = 2;
        context.stroke();
      }
    };
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [positions, result.edges, result.nodes, visibleEdgeIds, visibleNodeIds]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`Read-only social graph image with ${visibleNodeIds.size} people and ${visibleEdgeIds.size} relationships`}
      className="bg-muted block h-[32rem] w-full rounded-xl"
    />
  );
}
