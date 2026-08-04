import "server-only";

import { z } from "zod";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const uuid = z
  .string()
  .regex(UUID_PATTERN)
  .transform((value) => value.toLowerCase());
const scopedIds = z.array(uuid).min(1).max(20);
const personInput = z.object({ personId: uuid }).strict();
const evidenceInput = z.object({ evidenceId: uuid }).strict();
const searchPeopleInput = z
  .object({
    query: z.string().trim().min(1).max(500),
    personIds: scopedIds.optional(),
  })
  .strict();
const searchGraphInput = z
  .object({
    personIds: scopedIds,
    depth: z.number().int().min(1).max(2).default(1),
  })
  .strict();

export const RESEARCH_TOOL_NAMES = [
  "getEvidence",
  "getPerson",
  "searchGraph",
  "searchPeople",
] as const;
export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];

export type ResearchToolDenied = Readonly<{
  ok: false;
  code: "DENIED";
  summary: "The tool request was denied.";
  resourceIds: readonly string[];
  evidenceIds: readonly string[];
}>;

export type ResearchToolSuccess = Readonly<{
  ok: true;
  code: "OK";
  summary: Readonly<Record<string, unknown>>;
  resourceIds: readonly string[];
  evidenceIds: readonly string[];
}>;

export type ResearchToolResult = ResearchToolDenied | ResearchToolSuccess;
export type ResearchToolHandler = (
  input: unknown,
) => Promise<ResearchToolResult>;

type RecordLike = Readonly<Record<string, unknown>>;

export type ResearchToolsContext = Readonly<{
  scope: Readonly<{
    personIds: readonly string[];
    evidenceIds: readonly string[];
  }>;
  people: Readonly<{ get(id: string): Promise<RecordLike | null> }>;
  evidence: Readonly<{ getEvidence(id: string): Promise<RecordLike | null> }>;
  search: Readonly<{
    search(input: unknown): Promise<Readonly<{ nodes: readonly RecordLike[] }>>;
  }>;
  graph: Readonly<{
    query(input: {
      mode: "NEIGHBORHOOD";
      rootPersonIds: string[];
      depth: number;
      nodeLimit: number;
      edgeLimit: number;
      includeIsolates: false;
    }): Promise<
      Readonly<{
        nodes: readonly RecordLike[];
        edges: readonly RecordLike[];
        limits?: RecordLike;
      }>
    >;
  }>;
}>;

export type ResearchTools = Readonly<
  Record<ResearchToolName, ResearchToolHandler>
>;

const DENIED: ResearchToolDenied = Object.freeze({
  ok: false,
  code: "DENIED",
  summary: "The tool request was denied.",
  resourceIds: Object.freeze([]),
  evidenceIds: Object.freeze([]),
});

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, maximum);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function exactKeys(
  value: RecordLike,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string") result[key] = text(field, 2_000);
    else if (typeof field === "number") result[key] = number(field);
    else if (typeof field === "boolean") result[key] = field;
  }
  return result;
}

function inScope(
  requested: readonly string[],
  allowed: ReadonlySet<string>,
): boolean {
  return requested.every((id) => allowed.has(id));
}

function success(
  summary: Record<string, unknown>,
  resourceIds: readonly string[],
  evidenceIds: readonly string[] = [],
): ResearchToolSuccess {
  return Object.freeze({
    ok: true,
    code: "OK",
    summary: Object.freeze(summary),
    resourceIds: Object.freeze([...new Set(resourceIds)]),
    evidenceIds: Object.freeze([...new Set(evidenceIds)]),
  });
}

export function createResearchTools(
  context: ResearchToolsContext,
): ResearchTools {
  const personIds = new Set(
    context.scope.personIds
      .filter((id) => UUID_PATTERN.test(id))
      .map((id) => id.toLowerCase()),
  );
  const evidenceIds = new Set(
    context.scope.evidenceIds
      .filter((id) => UUID_PATTERN.test(id))
      .map((id) => id.toLowerCase()),
  );

  const tools: ResearchTools = {
    async getEvidence(raw) {
      const input = evidenceInput.safeParse(raw);
      if (!input.success || !evidenceIds.has(input.data.evidenceId))
        return DENIED;
      try {
        const row = await context.evidence.getEvidence(input.data.evidenceId);
        if (!row || row.id !== input.data.evidenceId) return DENIED;
        return success(
          {
            evidence: {
              ...exactKeys(row, [
                "id",
                "sourceId",
                "reviewState",
                "capturedAt",
                "sensitivity",
              ]),
              excerpt: text(row.extractedText, 1_000),
            },
          },
          [input.data.evidenceId],
          [input.data.evidenceId],
        );
      } catch {
        return DENIED;
      }
    },

    async getPerson(raw) {
      const input = personInput.safeParse(raw);
      if (!input.success || !personIds.has(input.data.personId)) return DENIED;
      try {
        const row = await context.people.get(input.data.personId);
        if (!row || row.id !== input.data.personId) return DENIED;
        return success(
          {
            person: {
              ...exactKeys(row, [
                "id",
                "displayName",
                "preferredName",
                "status",
                "sensitivity",
                "confidence",
              ]),
              biography: text(row.biography, 2_000),
            },
          },
          [input.data.personId],
        );
      } catch {
        return DENIED;
      }
    },

    async searchGraph(raw) {
      const input = searchGraphInput.safeParse(raw);
      if (!input.success || !inScope(input.data.personIds, personIds))
        return DENIED;
      try {
        const graph = await context.graph.query({
          mode: "NEIGHBORHOOD",
          rootPersonIds: input.data.personIds,
          depth: input.data.depth,
          nodeLimit: 50,
          edgeLimit: 100,
          includeIsolates: false,
        });
        const nodes = graph.nodes
          .filter((row) => typeof row.id === "string" && personIds.has(row.id))
          .slice(0, 50)
          .map((row) =>
            exactKeys(row, ["id", "displayName", "status", "sensitivity"]),
          );
        const returnedIds = nodes
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string");
        const returnedSet = new Set(returnedIds);
        const edges = graph.edges
          .filter(
            (row) =>
              typeof row.source === "string" &&
              typeof row.target === "string" &&
              returnedSet.has(row.source) &&
              returnedSet.has(row.target),
          )
          .slice(0, 100)
          .map((row) =>
            exactKeys(row, [
              "id",
              "relationshipId",
              "source",
              "target",
              "forwardLabel",
              "inverseLabel",
              "directed",
              "state",
              "confidence",
            ]),
          );
        return success(
          {
            nodes,
            edges,
            truncated:
              graph.nodes.length > nodes.length ||
              graph.edges.length > edges.length,
          },
          returnedIds,
        );
      } catch {
        return DENIED;
      }
    },

    async searchPeople(raw) {
      const input = searchPeopleInput.safeParse(raw);
      if (!input.success) return DENIED;
      const requestedIds = input.data.personIds ?? [...personIds];
      if (!inScope(requestedIds, personIds)) return DENIED;
      const requested = new Set(requestedIds);
      try {
        const result = await context.search.search({
          version: 1,
          match: { type: "text", query: input.data.query },
          filters: {},
          kinds: ["PERSON"],
          first: 10,
        });
        const returnedNodes = result.nodes
          .filter(
            (row) =>
              row.kind === "PERSON" &&
              typeof row.id === "string" &&
              personIds.has(row.id) &&
              requested.has(row.id),
          )
          .slice(0, 10);
        const people = returnedNodes.map((row) => ({
          ...exactKeys(row, ["id", "title", "rank", "updatedAt"]),
          snippet: Array.isArray(row.snippet)
            ? row.snippet
                .slice(0, 8)
                .map((part) =>
                  part && typeof part === "object"
                    ? exactKeys(part as RecordLike, ["text", "matched"])
                    : {},
                )
            : [],
        }));
        const returnedIds = returnedNodes
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string");
        return success({ people }, returnedIds);
      } catch {
        return DENIED;
      }
    },
  };
  return Object.freeze(tools);
}

export async function invokeResearchTool(
  tools: ResearchTools,
  name: string,
  input: unknown,
): Promise<ResearchToolResult> {
  if (!(RESEARCH_TOOL_NAMES as readonly string[]).includes(name)) return DENIED;
  return tools[name as ResearchToolName](input);
}
