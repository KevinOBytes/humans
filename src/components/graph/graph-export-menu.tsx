"use client";

import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  serializeGraphCsv,
  serializeGraphGexf,
  serializeGraphGraphMl,
  serializeGraphJson,
  serializeGraphSvg,
} from "@/modules/graph/export";
import type { GraphResult } from "@/modules/graph/types";
import type { GraphPosition } from "@/modules/graph/types";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function baseName(result: GraphResult) {
  return `humans-graph-${result.fingerprint.slice(0, 12)}`;
}

export function GraphExportMenu({
  onStatus,
  positions,
  result,
}: {
  onStatus?: (message: string) => void;
  positions?: readonly GraphPosition[];
  result: GraphResult;
}) {
  const [open, setOpen] = useState(false);
  const [pngPending, setPngPending] = useState(false);
  const downloadText = (content: string, extension: string, mime: string) => {
    downloadBlob(
      new Blob([content], { type: `${mime};charset=utf-8` }),
      `${baseName(result)}.${extension}`,
    );
    onStatus?.(`${extension.toUpperCase()} export prepared.`);
  };
  const csv = () => serializeGraphCsv(result);

  async function downloadPng() {
    if (pngPending) return;
    setPngPending(true);
    onStatus?.("Preparing PNG export.");
    const svg = serializeGraphSvg(result, positions);
    const sourceUrl = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () =>
          reject(new Error("The graph SVG could not be rasterized."));
        image.src = sourceUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 900;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is unavailable.");
      context.drawImage(image, 0, 0, 1600, 900);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("PNG encoding failed.")),
          "image/png",
        );
      });
      downloadBlob(blob, `${baseName(result)}.png`);
      onStatus?.("PNG export prepared.");
    } catch {
      onStatus?.("PNG export could not be prepared in this browser.");
    } finally {
      URL.revokeObjectURL(sourceUrl);
      setPngPending(false);
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls="graph-export-options"
        onClick={() => setOpen((value) => !value)}
      >
        <Download aria-hidden="true" data-icon="inline-start" />
        Export
        <ChevronDown aria-hidden="true" />
      </Button>
      {open ? (
        <div
          id="graph-export-options"
          className="border-border bg-popover absolute right-0 z-30 mt-2 grid w-64 gap-1 rounded-xl border p-2 shadow-xl"
        >
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() =>
              downloadText(
                serializeGraphJson(result),
                "json",
                "application/json",
              )
            }
          >
            Download JSON
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() => downloadText(csv().nodes, "nodes.csv", "text/csv")}
          >
            Download nodes CSV
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() =>
              downloadText(csv().edges, "relationships.csv", "text/csv")
            }
          >
            Download relationships CSV
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() =>
              downloadText(
                serializeGraphGexf(result),
                "gexf",
                "application/gexf+xml",
              )
            }
          >
            Download GEXF
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() =>
              downloadText(
                serializeGraphGraphMl(result),
                "graphml",
                "application/graphml+xml",
              )
            }
          >
            Download GraphML
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={() =>
              downloadText(
                serializeGraphSvg(result, positions),
                "svg",
                "image/svg+xml",
              )
            }
          >
            Download SVG
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            disabled={pngPending}
            onClick={downloadPng}
          >
            {pngPending ? "Preparing PNG…" : "Download PNG"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
