import { deterministicCirclePositions } from "./transform";
import type { GraphPosition, GraphResult } from "./types";

function sortedResult(result: GraphResult) {
  return {
    schema: "humans.graph-export.v1",
    fingerprint: result.fingerprint,
    generatedAt: new Date(result.generatedAt).toISOString(),
    filter: result.normalizedFilter,
    truncation: result.limits,
    nodes: [...result.nodes].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    edges: [...result.edges].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

export function serializeGraphJson(result: GraphResult): string {
  return `${JSON.stringify(sortedResult(result), null, 2)}\n`;
}

function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRows(
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>,
) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export type AnalysisExportResult = Readonly<{
  explanation: string | null;
  numericValue: string | null;
  rank: number | null;
  resultKind: string;
  subjectPersonId: string | null;
}>;

function sortedAnalysisResults(results: readonly AnalysisExportResult[]) {
  for (const result of results) {
    if (
      result.numericValue !== null &&
      !Number.isFinite(Number(result.numericValue))
    )
      throw new TypeError("The graph analysis export value is invalid.");
  }
  return [...results].sort(
    (left, right) =>
      (left.rank ?? Number.MAX_SAFE_INTEGER) -
        (right.rank ?? Number.MAX_SAFE_INTEGER) ||
      (left.subjectPersonId ?? "").localeCompare(right.subjectPersonId ?? "") ||
      left.resultKind.localeCompare(right.resultKind),
  );
}

export function serializeAnalysisResultsJson(input: {
  algorithm: string;
  algorithmVersion: string;
  configurationHash: string;
  results: readonly AnalysisExportResult[];
  truncated: boolean;
}): string {
  return `${JSON.stringify(
    {
      schema: "humans.graph-analysis-export.v1",
      algorithm: input.algorithm,
      algorithmVersion: input.algorithmVersion,
      configurationHash: input.configurationHash,
      truncated: input.truncated,
      results: sortedAnalysisResults(input.results).map((result) => ({
        resultKind: result.resultKind,
        subjectPersonId: result.subjectPersonId,
        value:
          result.numericValue === null ? null : Number(result.numericValue),
        rank: result.rank,
        explanation: result.explanation,
      })),
    },
    null,
    2,
  )}\n`;
}

export function serializeAnalysisResultsCsv(
  results: readonly AnalysisExportResult[],
): string {
  return csvRows([
    ["result_kind", "subject_person_id", "value", "rank", "explanation"],
    ...sortedAnalysisResults(results).map((result) => [
      result.resultKind,
      result.subjectPersonId,
      result.numericValue,
      result.rank,
      result.explanation,
    ]),
  ]);
}

export function serializeGraphCsv(result: GraphResult): {
  nodes: string;
  edges: string;
} {
  const canonical = sortedResult(result);
  return {
    nodes: csvRows([
      [
        "person_id",
        "display_name",
        "status",
        "sensitivity",
        "version",
        "degree",
        "community",
      ],
      ...canonical.nodes.map((node) => [
        node.id,
        node.displayName,
        node.status,
        node.sensitivity,
        node.version,
        "",
        "",
      ]),
    ]),
    edges: csvRows([
      [
        "relationship_id",
        "source_person_id",
        "target_person_id",
        "type_id",
        "label",
        "directed",
        "state",
        "sensitivity",
        "confidence",
        "strength",
        "valid_from",
        "valid_until",
        "version",
      ],
      ...canonical.edges.map((edge) => [
        edge.relationshipId,
        edge.source,
        edge.target,
        edge.relationshipTypeId,
        edge.forwardLabel,
        edge.directed,
        edge.state,
        edge.sensitivity,
        edge.confidence,
        edge.strength,
        edge.validFrom,
        edge.validUntil,
        edge.version,
      ]),
    ]),
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export function serializeGraphGexf(result: GraphResult): string {
  const canonical = sortedResult(result);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gexf xmlns="http://gexf.net/1.3" version="1.3">',
    '  <graph mode="static" defaultedgetype="directed">',
    '    <attributes class="node">',
    '      <attribute id="status" title="Status" type="string"/>',
    '      <attribute id="sensitivity" title="Sensitivity" type="string"/>',
    '      <attribute id="version" title="Version" type="integer"/>',
    "    </attributes>",
    '    <attributes class="edge">',
    '      <attribute id="relationship_type_id" title="Relationship type ID" type="string"/>',
    '      <attribute id="state" title="State" type="string"/>',
    '      <attribute id="sensitivity" title="Sensitivity" type="string"/>',
    '      <attribute id="confidence" title="Confidence" type="double"/>',
    '      <attribute id="strength" title="Strength" type="double"/>',
    '      <attribute id="valid_from" title="Valid from" type="string"/>',
    '      <attribute id="valid_until" title="Valid until" type="string"/>',
    '      <attribute id="version" title="Version" type="integer"/>',
    "    </attributes>",
    "    <nodes>",
  ];
  for (const node of canonical.nodes) {
    lines.push(
      `      <node id="${xml(node.id)}" label="${xml(node.displayName)}">`,
      "        <attvalues>",
      `          <attvalue for="status" value="${xml(node.status)}"/>`,
      `          <attvalue for="sensitivity" value="${xml(node.sensitivity)}"/>`,
      `          <attvalue for="version" value="${node.version}"/>`,
      "        </attvalues>",
      "      </node>",
    );
  }
  lines.push("    </nodes>", "    <edges>");
  for (const edge of canonical.edges) {
    lines.push(
      `      <edge id="${xml(edge.relationshipId)}" source="${xml(edge.source)}" target="${xml(edge.target)}" label="${xml(edge.forwardLabel)}"${edge.directed ? "" : ' type="undirected"'}>`,
      "        <attvalues>",
      `          <attvalue for="relationship_type_id" value="${xml(edge.relationshipTypeId)}"/>`,
      `          <attvalue for="state" value="${xml(edge.state)}"/>`,
      `          <attvalue for="sensitivity" value="${xml(edge.sensitivity)}"/>`,
      `          <attvalue for="confidence" value="${edge.confidence}"/>`,
      `          <attvalue for="strength" value="${xmlNumber(edge.strength)}"/>`,
      `          <attvalue for="valid_from" value="${xml(edge.validFrom ?? "")}"/>`,
      `          <attvalue for="valid_until" value="${xml(edge.validUntil ?? "")}"/>`,
      `          <attvalue for="version" value="${edge.version}"/>`,
      "        </attvalues>",
      "      </edge>",
    );
  }
  lines.push("    </edges>", "  </graph>", "</gexf>", "");
  return lines.join("\n");
}

export function serializeGraphGraphMl(result: GraphResult): string {
  const canonical = sortedResult(result);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="node_label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="node_status" for="node" attr.name="status" attr.type="string"/>',
    '  <key id="node_sensitivity" for="node" attr.name="sensitivity" attr.type="string"/>',
    '  <key id="edge_label" for="edge" attr.name="label" attr.type="string"/>',
    '  <key id="edge_type" for="edge" attr.name="relationship_type_id" attr.type="string"/>',
    '  <key id="edge_state" for="edge" attr.name="state" attr.type="string"/>',
    '  <key id="edge_sensitivity" for="edge" attr.name="sensitivity" attr.type="string"/>',
    '  <key id="edge_confidence" for="edge" attr.name="confidence" attr.type="double"/>',
    '  <key id="edge_strength" for="edge" attr.name="strength" attr.type="double"/>',
    '  <graph id="authorized-graph" edgedefault="directed">',
  ];
  for (const node of canonical.nodes) {
    lines.push(
      `    <node id="${xml(node.id)}">`,
      `      <data key="node_label">${xml(node.displayName)}</data>`,
      `      <data key="node_status">${xml(node.status)}</data>`,
      `      <data key="node_sensitivity">${xml(node.sensitivity)}</data>`,
      "    </node>",
    );
  }
  for (const edge of canonical.edges) {
    lines.push(
      `    <edge id="${xml(edge.relationshipId)}" source="${xml(edge.source)}" target="${xml(edge.target)}"${edge.directed ? "" : ' directed="false"'}>`,
      `      <data key="edge_label">${xml(edge.forwardLabel)}</data>`,
      `      <data key="edge_type">${xml(edge.relationshipTypeId)}</data>`,
      `      <data key="edge_state">${xml(edge.state)}</data>`,
      `      <data key="edge_sensitivity">${xml(edge.sensitivity)}</data>`,
      `      <data key="edge_confidence">${edge.confidence}</data>`,
      ...(edge.strength === null
        ? []
        : [`      <data key="edge_strength">${edge.strength}</data>`]),
      "    </edge>",
    );
  }
  lines.push("  </graph>", "</graphml>", "");
  return lines.join("\n");
}

function validPositions(
  result: GraphResult,
  supplied?: readonly GraphPosition[],
) {
  const expected = new Set(result.nodes.map(({ id }) => id));
  const candidates = supplied ?? deterministicCirclePositions([...expected]);
  const ids = new Set(candidates.map(({ id }) => id));
  if (
    candidates.length !== expected.size ||
    ids.size !== expected.size ||
    candidates.some(
      ({ id, x, y }) =>
        !expected.has(id) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        Math.abs(x) > 1_000_000 ||
        Math.abs(y) > 1_000_000,
    )
  ) {
    return deterministicCirclePositions([...expected]);
  }
  return [...candidates].sort((left, right) => left.id.localeCompare(right.id));
}

export function serializeGraphSvg(
  result: GraphResult,
  supplied?: readonly GraphPosition[],
): string {
  const canonical = sortedResult(result);
  const positions = validPositions(result, supplied);
  const minimumX = Math.min(...positions.map(({ x }) => x), 0);
  const maximumX = Math.max(...positions.map(({ x }) => x), 1);
  const minimumY = Math.min(...positions.map(({ y }) => y), 0);
  const maximumY = Math.max(...positions.map(({ y }) => y), 1);
  const width = Math.max(maximumX - minimumX, 1);
  const height = Math.max(maximumY - minimumY, 1);
  const project = ({ x, y }: GraphPosition) => ({
    x: 80 + ((x - minimumX) / width) * 1440,
    y: 80 + ((y - minimumY) / height) * 740,
  });
  const projected = new Map(
    positions.map((position) => [position.id, project(position)]),
  );
  const lines: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900" role="img" aria-labelledby="graph-title">',
    '  <title id="graph-title">Humans authorized social graph</title>',
    '  <rect width="1600" height="900" fill="#f8fafc"/>',
    '  <g fill="none" stroke="#64748b" stroke-width="2">',
  ];
  for (const edge of canonical.edges) {
    const source = projected.get(edge.source);
    const target = projected.get(edge.target);
    if (!source || !target) continue;
    if (edge.source === edge.target)
      lines.push(
        `    <circle cx="${source.x.toFixed(3)}" cy="${(source.y - 18).toFixed(3)}" r="18"/>`,
      );
    else
      lines.push(
        `    <line x1="${source.x.toFixed(3)}" y1="${source.y.toFixed(3)}" x2="${target.x.toFixed(3)}" y2="${target.y.toFixed(3)}"${edge.directed ? ' stroke-dasharray="8 4"' : ""}/>`,
      );
  }
  lines.push(
    "  </g>",
    '  <g fill="#2563eb" stroke="#0f172a" stroke-width="2">',
  );
  for (const node of canonical.nodes) {
    const point = projected.get(node.id);
    if (point)
      lines.push(
        `    <circle cx="${point.x.toFixed(3)}" cy="${point.y.toFixed(3)}" r="10"/>`,
      );
  }
  lines.push(
    "  </g>",
    '  <g fill="#0f172a" font-family="ui-sans-serif, sans-serif" font-size="14">',
  );
  for (const node of canonical.nodes.slice(0, 250)) {
    const point = projected.get(node.id);
    if (point)
      lines.push(
        `    <text x="${(point.x + 14).toFixed(3)}" y="${(point.y + 5).toFixed(3)}">${xml(node.displayName)}</text>`,
      );
  }
  lines.push("  </g>", "</svg>", "");
  return lines.join("\n");
}
