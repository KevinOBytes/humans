import { describe, expect, it } from "vitest";

import {
  analyzeResearch,
  filterResearchRows,
  normalizeResearchFacets,
} from "@/modules/search/analysis";

const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const rows = [
  {
    id: "a",
    workspaceId,
    subjectPersonId: "p1",
    fieldKey: "role",
    value: "Engineer",
    title: "Alice",
    sensitivity: "public",
    sourceReliability: 0.9,
    observedAt: "2025-01-01T00:00:00Z",
    reviewState: "approved",
  },
  {
    id: "b",
    workspaceId,
    subjectPersonId: "p1",
    fieldKey: "role",
    value: "Researcher",
    title: "Alice",
    sensitivity: "internal",
    sourceReliability: 0.5,
    observedAt: "2025-02-01T00:00:00Z",
    reviewState: "unreviewed",
  },
  {
    id: "c",
    workspaceId: "other",
    subjectPersonId: "p2",
    fieldKey: "role",
    value: "Engineer",
    title: "Bob",
    sensitivity: "public",
    sourceReliability: 1,
    observedAt: "2025-01-01T00:00:00Z",
    reviewState: "approved",
  },
];

describe("governed research analysis", () => {
  it("normalizes bounded facets and preserves temporal filters", () => {
    expect(
      normalizeResearchFacets({
        sensitivity: ["public", "public"],
        temporalRange: { from: "2025-01-01", until: "2025-01-31" },
      }),
    ).toEqual({
      sensitivity: ["public"],
      temporalRange: { from: "2025-01-01", until: "2025-01-31" },
    });
  });
  it("always applies workspace and sensitivity ceilings before aggregation", () => {
    expect(
      filterResearchRows(rows, {
        workspaceId,
        purpose: "case-review",
        allowedSensitivity: "public",
      }),
    ).toHaveLength(1);
  });
  it("reports contradictions without producing an adverse score", () => {
    const result = analyzeResearch({
      kind: "CONTRADICTIONS",
      rows,
      context: {
        workspaceId,
        purpose: "case-review",
        allowedSensitivity: "restricted",
      },
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ key: `${"p1"}:role` });
    expect(result.explanation.methodology).toContain("no adverse inference");
  });

  it("applies zero reliability bounds and excludes missing reliability", () => {
    const values = [
      { id: "zero", workspaceId, sourceReliability: 0 },
      { id: "positive", workspaceId, sourceReliability: 0.5 },
      { id: "unknown", workspaceId },
    ];
    expect(
      filterResearchRows(
        values,
        { workspaceId, purpose: "review" },
        {
          sourceReliability: { max: 0 },
        },
      ).map((row) => row.id),
    ).toEqual(["zero"]);
    expect(
      filterResearchRows(
        values,
        { workspaceId, purpose: "review" },
        {
          sourceReliability: { min: 0 },
        },
      ).map((row) => row.id),
    ).toEqual(["zero", "positive"]);
  });

  it("counts unique directed relationship edges, not fact rows or provenance copies", () => {
    const edge = {
      id: "r1",
      workspaceId,
      kind: "RELATIONSHIP",
      sourcePersonId: "p1",
      targetPersonId: "p2",
    };
    const result = analyzeResearch({
      kind: "GRAPH_METRICS",
      rows: [
        edge,
        edge,
        { ...edge, id: "r2", sourcePersonId: "p2", targetPersonId: "p1" },
        { id: "f1", workspaceId, kind: "FACT", subjectPersonId: "p1" },
        { ...edge, id: "hidden", workspaceId: "other" },
      ],
      context: { workspaceId, purpose: "review" },
    });
    expect(result.rows).toEqual([
      expect.objectContaining({
        personId: "p1",
        degree: 2,
        inDegree: 1,
        outDegree: 1,
      }),
      expect.objectContaining({
        personId: "p2",
        degree: 2,
        inDegree: 1,
        outDegree: 1,
      }),
    ]);
  });

  it("never compares unrelated subjects or treats missing values as contradictions", () => {
    const result = analyzeResearch({
      kind: "CONTRADICTIONS",
      rows: [
        { id: "1", workspaceId, value: "a" },
        { id: "2", workspaceId, value: "b" },
        {
          id: "3",
          workspaceId,
          subjectPersonId: "p",
          fieldKey: "role",
          value: null,
        },
        {
          id: "4",
          workspaceId,
          subjectPersonId: "p",
          fieldKey: "role",
          value: "Engineer",
        },
      ],
      context: { workspaceId, purpose: "review" },
    });
    expect(result.rows).toEqual([]);
  });

  it("compares sources by subject and field with distinct cited-source counts", () => {
    const result = analyzeResearch({
      kind: "SOURCE_COMPARISON",
      rows: [
        {
          id: "1",
          workspaceId,
          subjectPersonId: "a",
          fieldKey: "role",
          sourceId: "s1",
          value: "Engineer",
        },
        {
          id: "2",
          workspaceId,
          subjectPersonId: "a",
          fieldKey: "role",
          sourceId: "s1",
          value: "Engineer",
        },
        {
          id: "3",
          workspaceId,
          subjectPersonId: "b",
          fieldKey: "role",
          sourceId: "s2",
          value: "Writer",
        },
        {
          id: "4",
          workspaceId,
          subjectPersonId: "a",
          fieldKey: "role",
          value: "unknown source",
        },
      ],
      context: { workspaceId, purpose: "review" },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => [row.key, row.sourceCount])).toEqual([
      ["a:role", 1],
      ["b:role", 1],
    ]);
  });
});
