import { describe, expect, it } from "vitest";

import {
  serializeAnalysisResultsCsv,
  serializeAnalysisResultsJson,
  serializeGraphCsv,
  serializeGraphGexf,
  serializeGraphGraphMl,
  serializeGraphJson,
  serializeGraphSvg,
} from "@/modules/graph/export";
import { graphResultFixture, IDS } from "../fixtures/graph";

describe("graph export", () => {
  it("exports bounded analysis fields deterministically and neutralizes CSV formulas", () => {
    const results = [
      {
        explanation: "\t=unsafe formula",
        numericValue: "2.5",
        rank: 2,
        resultKind: "pagerank",
        subjectPersonId: IDS.bob,
      },
      {
        explanation: "Visible rank",
        numericValue: "3.5",
        rank: 1,
        resultKind: "pagerank",
        subjectPersonId: IDS.alice,
      },
    ];
    const json = serializeAnalysisResultsJson({
      algorithm: "PAGERANK",
      algorithmVersion: "fixed-v1",
      configurationHash: "a".repeat(64),
      results: results.toReversed(),
      truncated: false,
    });
    expect(json).toBe(
      serializeAnalysisResultsJson({
        algorithm: "PAGERANK",
        algorithmVersion: "fixed-v1",
        configurationHash: "a".repeat(64),
        results,
        truncated: false,
      }),
    );
    expect(JSON.parse(json)).not.toHaveProperty("workspaceId");
    expect(json).not.toContain("analysisRunId");
    const csv = serializeAnalysisResultsCsv(results);
    expect(csv).toMatch(
      /^result_kind,subject_person_id,value,rank,explanation/mu,
    );
    expect(csv).toContain("'\t=unsafe formula");
    expect(csv).not.toMatch(/,\t=unsafe formula/u);
    for (const dangerous of [" @unsafe", "\r=unsafe", "\n+unsafe"]) {
      const adversarial = serializeAnalysisResultsCsv([
        { ...results[0]!, explanation: dangerous },
      ]);
      expect(adversarial).toContain(`'${dangerous}`);
    }
    expect(() =>
      serializeAnalysisResultsJson({
        algorithm: "PAGERANK",
        algorithmVersion: "fixed-v1",
        configurationHash: "a".repeat(64),
        results: [{ ...results[0]!, numericValue: "NaN" }],
        truncated: false,
      }),
    ).toThrow(/export value/u);
  });

  it("serializes canonical JSON independently of result input order", () => {
    const shuffled = {
      ...graphResultFixture,
      nodes: graphResultFixture.nodes.toReversed(),
      edges: graphResultFixture.edges.toReversed(),
    };
    const first = serializeGraphJson(graphResultFixture);
    expect(serializeGraphJson(shuffled)).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(parsed.schema).toBe("humans.graph-export.v1");
    expect(parsed).not.toHaveProperty("workspaceId");
    expect(parsed).not.toHaveProperty("exportedAt");
  });

  it("uses fixed RFC 4180 CSV headers and neutralizes spreadsheet formulas", () => {
    const csv = serializeGraphCsv(graphResultFixture);
    expect(csv.nodes).toMatch(/^person_id,display_name,status,sensitivity/mu);
    expect(csv.edges).toMatch(
      /^relationship_id,source_person_id,target_person_id,type_id,label,directed/mu,
    );
    expect(csv.nodes).toContain('"\'=Researcher, Alice"');
    expect(csv.nodes).not.toMatch(/\r\n=Researcher/u);
    expect(csv.nodes.endsWith("\r\n")).toBe(true);
  });

  it("produces deterministic inert SVG with safe text and fixed geometry", () => {
    const svg = serializeGraphSvg(graphResultFixture, [
      { id: IDS.alice, x: 0, y: 0 },
      { id: IDS.bob, x: 1, y: 0 },
      { id: IDS.casey, x: 0.5, y: 1 },
    ]);
    expect(svg).toContain('viewBox="0 0 1600 900"');
    expect(svg).toContain("Bob &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toMatch(/<script|foreignObject|onerror|href=/u);
    expect(serializeGraphSvg(graphResultFixture)).toBe(
      serializeGraphSvg({
        ...graphResultFixture,
        nodes: graphResultFixture.nodes.toReversed(),
        edges: graphResultFixture.edges.toReversed(),
      }),
    );
    expect(
      serializeGraphSvg(graphResultFixture, [
        { id: IDS.alice, x: Number.NaN, y: 0 },
        { id: IDS.bob, x: 1, y: 0 },
        { id: IDS.casey, x: 0, y: 1 },
      ]),
    ).toBe(serializeGraphSvg(graphResultFixture));
  });

  it("produces deterministic inert GEXF and GraphML interchange documents", () => {
    const shuffled = {
      ...graphResultFixture,
      nodes: graphResultFixture.nodes.toReversed(),
      edges: graphResultFixture.edges.toReversed(),
    };
    const gexf = serializeGraphGexf(graphResultFixture);
    const graphMl = serializeGraphGraphMl(graphResultFixture);

    expect(gexf).toBe(serializeGraphGexf(shuffled));
    expect(graphMl).toBe(serializeGraphGraphMl(shuffled));
    expect(gexf).toContain('<gexf xmlns="http://gexf.net/1.3"');
    expect(gexf).toContain('defaultedgetype="directed"');
    expect(gexf).toContain('type="undirected"');
    expect(graphMl).toContain(
      '<graphml xmlns="http://graphml.graphdrawing.org/xmlns"',
    );
    expect(graphMl).toContain('edgedefault="directed"');
    expect(graphMl).toContain('directed="false"');
    for (const document of [gexf, graphMl]) {
      expect(document).toContain("Bob &lt;script&gt;alert(1)&lt;/script&gt;");
      expect(document).not.toMatch(
        /<script|foreignObject|javascript:|onerror|href=/iu,
      );
      expect(document.endsWith("\n")).toBe(true);
    }
  });
});
