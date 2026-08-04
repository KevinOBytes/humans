import { describe, expect, it, vi } from "vitest";

import {
  createResearchTools,
  invokeResearchTool,
  type ResearchToolsContext,
} from "@/modules/ai/tools";

const personId = "018f0d90-1111-7111-8111-111111111111";
const evidenceId = "018f0d90-2222-7222-8222-222222222222";
const foreignId = "018f0d90-3333-7333-8333-333333333333";

function context(): ResearchToolsContext {
  return {
    scope: Object.freeze({ personIds: [personId], evidenceIds: [evidenceId] }),
    people: {
      get: vi.fn(async (id) =>
        id === personId
          ? {
              id,
              displayName: "Alice",
              biography: "A".repeat(4_000),
              status: "active",
            }
          : null,
      ),
    },
    evidence: {
      getEvidence: vi.fn(async (id) =>
        id === evidenceId
          ? {
              id,
              sourceId: "018f0d90-4444-7444-8444-444444444444",
              extractedText: `approved ${"raw".repeat(2_000)}`,
              reviewState: "verified",
            }
          : null,
      ),
    },
    search: {
      search: vi.fn(async () => ({
        nodes: [
          {
            id: personId,
            kind: "PERSON",
            rank: 1,
            snippet: [{ text: "Alice", matched: true }],
            subjectPersonId: personId,
            title: "Alice",
            updatedAt: "2026-08-04T00:00:00.000Z",
          },
          {
            id: foreignId,
            kind: "PERSON",
            rank: 0.5,
            snippet: [{ text: "Foreign", matched: true }],
            subjectPersonId: foreignId,
            title: "Foreign",
            updatedAt: "2026-08-04T00:00:00.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      })),
    },
    graph: {
      query: vi.fn(async () => ({
        nodes: [
          {
            id: personId,
            displayName: "Alice",
            status: "active",
            sensitivity: "internal",
            version: 1,
          },
          {
            id: foreignId,
            displayName: "Foreign",
            status: "active",
            sensitivity: "public",
            version: 1,
          },
        ],
        edges: [],
        normalizedFilter: {},
        limits: { nodesTruncated: false, edgesTruncated: false, reasons: [] },
        fingerprint: "f".repeat(64),
        generatedAt: "2026-08-04T00:00:00.000Z",
      })),
    },
  };
}

describe("AI research tools", () => {
  it("exports exactly four authorized read operations", () => {
    expect(Object.keys(createResearchTools(context())).sort()).toEqual([
      "getEvidence",
      "getPerson",
      "searchGraph",
      "searchPeople",
    ]);
  });

  it.each(["deletePerson", "updateEvidence", "fetchUrl", "unknown"])(
    "denies unknown or mutation-like tool %s",
    async (name) => {
      const value = context();
      const tools = createResearchTools(value);

      await expect(invokeResearchTool(tools, name, {})).resolves.toEqual({
        ok: false,
        code: "DENIED",
        summary: "The tool request was denied.",
        resourceIds: [],
        evidenceIds: [],
      });
      expect(value.people.get).not.toHaveBeenCalled();
      expect(value.evidence.getEvidence).not.toHaveBeenCalled();
      expect(value.search.search).not.toHaveBeenCalled();
      expect(value.graph.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["getPerson", { personId: foreignId }],
    ["getPerson", { personId, url: "https://example.com/private" }],
    ["getEvidence", { evidenceId: foreignId }],
    ["searchGraph", { personIds: [personId, foreignId] }],
    ["searchPeople", { query: "alice", personIds: [foreignId] }],
  ] as const)(
    "denies invalid or out-of-scope %s arguments",
    async (name, args) => {
      const value = context();
      const tools = createResearchTools(value);

      await expect(
        invokeResearchTool(tools, name, args),
      ).resolves.toMatchObject({
        ok: false,
        code: "DENIED",
        resourceIds: [],
        evidenceIds: [],
      });
      expect(value.people.get).not.toHaveBeenCalled();
      expect(value.evidence.getEvidence).not.toHaveBeenCalled();
      expect(value.search.search).not.toHaveBeenCalled();
      expect(value.graph.query).not.toHaveBeenCalled();
    },
  );

  it("uses authorized services and returns only scoped, bounded summaries", async () => {
    const value = context();
    const tools = createResearchTools(value);

    const person = await tools.getPerson({ personId });
    const evidence = await tools.getEvidence({ evidenceId });
    const people = await tools.searchPeople({
      query: "Alice",
      personIds: [personId],
    });
    const graph = await tools.searchGraph({ personIds: [personId], depth: 1 });

    expect(person).toMatchObject({
      ok: true,
      resourceIds: [personId],
      evidenceIds: [],
    });
    expect(evidence).toMatchObject({
      ok: true,
      resourceIds: [evidenceId],
      evidenceIds: [evidenceId],
    });
    expect(people).toMatchObject({ ok: true, resourceIds: [personId] });
    expect(graph).toMatchObject({ ok: true, resourceIds: [personId] });
    expect(JSON.stringify(person).length).toBeLessThan(4_000);
    expect(JSON.stringify(evidence).length).toBeLessThan(2_000);
    expect(JSON.stringify(people)).not.toContain(foreignId);
    expect(JSON.stringify(graph)).not.toContain(foreignId);
    expect(value.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ["PERSON"], first: 10 }),
    );
    expect(value.graph.query).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "NEIGHBORHOOD",
        rootPersonIds: [personId],
      }),
    );
  });

  it("returns the same denial for resources no longer visible", async () => {
    const value = context();
    vi.mocked(value.people.get).mockResolvedValueOnce(null);
    vi.mocked(value.evidence.getEvidence).mockResolvedValueOnce(null);
    const tools = createResearchTools(value);

    await expect(tools.getPerson({ personId })).resolves.toMatchObject({
      ok: false,
      code: "DENIED",
    });
    await expect(tools.getEvidence({ evidenceId })).resolves.toMatchObject({
      ok: false,
      code: "DENIED",
    });
  });
});
