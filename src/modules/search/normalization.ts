import "server-only";

import { createHash } from "node:crypto";

import { createGraphQLError } from "@/graphql/errors";

export const SEARCH_RESULT_KINDS = [
  "PERSON",
  "FACT",
  "ADDRESS",
  "RELATIONSHIP",
  "EVIDENCE",
] as const;
export const SEARCH_SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];
export type SearchSensitivity = (typeof SEARCH_SENSITIVITIES)[number];
export type SearchFilters = {
  personIds?: string[];
  factDefinitionIds?: string[];
  factStates?: string[];
  relationshipTypeIds?: string[];
  relationshipStates?: string[];
  sourceIds?: string[];
  sensitivities?: SearchSensitivity[];
  at?: string;
  from?: string;
  until?: string;
};
export type NormalizedSearchInput = {
  version: 1;
  match:
    | { type: "text"; query: string }
    | {
        type: "protectedExact";
        kind: "PHONE" | "PERSON_IDENTIFIER";
        value: string;
        namespace?: string;
      };
  kinds: SearchResultKind[];
  filters: SearchFilters;
  first: number;
  after: string | null;
};
export type SavedSearchAstV1 = {
  schema: "humans.search-query";
  version: 1;
  match: { type: "text"; query: string };
  kinds: SearchResultKind[];
  filters: SearchFilters;
  pageSize: number;
};

export function calculateSearchWorkCost(input: {
  filterLeaves: number;
  first: number;
  kinds: number;
  terms: number;
}): Readonly<{ budget: number; complexity: number }> {
  const first = Math.min(Math.max(Math.trunc(input.first), 1), 100);
  const kinds = Math.min(Math.max(Math.trunc(input.kinds), 1), 5);
  const terms = Math.min(Math.max(Math.trunc(input.terms), 1), 16);
  const filterLeaves = Math.min(
    Math.max(Math.trunc(input.filterLeaves), 0),
    256,
  );
  return Object.freeze({
    budget: 20 + first + kinds * 5 + terms * 3 + filterLeaves * 2,
    complexity: 30 + first * 2 + kinds * 5 + terms * 3 + filterLeaves * 2,
  });
}

/**
 * PostgreSQL's `simple` text-search configuration does not fold accents. Keep
 * the fold in the application so indexing and query normalization use exactly
 * the same deterministic Unicode transformation without a database extension.
 */
export function foldSearchDiacritics(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC");
}

type SearchLexeme = Readonly<{
  bytes: number;
  operator: boolean;
  value: string;
}>;

/** Mirrors the work-producing lexemes emitted by websearch_to_tsquery(simple).
 * Hyphenated input emits its compound token and each component; OR is
 * case-insensitive in PostgreSQL web-search syntax.
 */
export function searchLexemes(query: string): readonly SearchLexeme[] {
  const tokens: SearchLexeme[] = [];
  const pattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_'-]*/gu;
  let quoted = false;
  let previousEnd = 0;
  for (const match of query.matchAll(pattern)) {
    const index = match.index;
    const token = match[0];
    for (let cursor = previousEnd; cursor < index; cursor += 1)
      if (query[cursor] === '"') quoted = !quoted;
    previousEnd = index + token.length;
    const negated =
      query[index - 1] === "-" &&
      (index === 1 || /\s/u.test(query[index - 2] ?? ""));
    if (/^or$/iu.test(token) && !quoted && !negated) {
      tokens.push({ bytes: bytes(token), operator: true, value: token });
      continue;
    }
    const parts = token.split(/-+/u).filter(Boolean);
    const expanded = parts.length > 1 ? [token, ...parts] : [token];
    tokens.push(
      ...expanded.map((value) => ({
        bytes: bytes(value),
        operator: false,
        value,
      })),
    );
  }
  return tokens;
}

export function normalizedSearchWorkCost(input: NormalizedSearchInput) {
  const terms =
    input.match.type === "text"
      ? searchLexemes(input.match.query).filter((term) => !term.operator).length
      : 1;
  const filterLeaves = Object.values(input.filters).reduce(
    (total, value) =>
      total + (Array.isArray(value) ? value.length : value ? 1 : 0),
    0,
  );
  return calculateSearchWorkCost({
    filterLeaves,
    first: input.first,
    kinds: input.kinds.length,
    terms,
  });
}

const encoder = new TextEncoder();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FACT_STATES = [
  "asserted",
  "corroborated",
  "disputed",
  "disproven",
  "superseded",
  "unknown",
] as const;
const RELATIONSHIP_STATES = [
  "asserted",
  "inferred",
  "corroborated",
  "disputed",
  "disproven",
  "inactive",
] as const;
const FILTER_KEYS = [
  "personIds",
  "factDefinitionIds",
  "factStates",
  "relationshipTypeIds",
  "relationshipStates",
  "sourceIds",
  "sensitivities",
  "at",
  "from",
  "until",
] as const;

function invalid(message = "The search request is invalid."): never {
  throw createGraphQLError("VALIDATION_FAILED", message);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const names = keys as string[];
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => names.includes(key)) &&
    names.every((key) => allowed.has(key))
  );
}

function bytes(value: string) {
  return encoder.encode(value).byteLength;
}

export function normalizeSearchText(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const normalized = foldSearchDiacritics(value).trim().replace(/\s+/gu, " ");
  if (
    bytes(normalized) < 1 ||
    bytes(normalized) > 256 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  )
    return invalid();
  const quotes = [...normalized].filter(
    (character) => character === '"',
  ).length;
  if (quotes % 2 !== 0 || quotes / 2 > 4) return invalid();
  const lexemes = searchLexemes(normalized);
  if (lexemes.filter((term) => term.operator).length > 4) return invalid();
  if ((normalized.match(/(?:^|\s)-(?=[\p{L}\p{N}"])/gu) ?? []).length > 4)
    return invalid();
  const searchable = lexemes.filter((term) => !term.operator);
  if (
    searchable.length < 1 ||
    searchable.length > 16 ||
    searchable.some((term) => term.bytes > 64)
  )
    return invalid();
  if (!/(?:^|\s)(?!-)(?:"?)[\p{L}\p{N}]/u.test(normalized)) return invalid();
  return normalized;
}

function normalizeUuidSet(value: unknown, cap: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > cap) return invalid();
  const result = [
    ...new Set(
      value.map((item) => {
        if (typeof item !== "string" || !UUID.test(item)) return invalid();
        return item.toLowerCase();
      }),
    ),
  ].sort();
  return result.length ? result : undefined;
}

function normalizeEnumSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  cap: number,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > cap) return invalid();
  const accepted = new Set(allowed);
  const result = [
    ...new Set(
      value.map((item) => {
        if (typeof item !== "string" || !accepted.has(item as T))
          return invalid();
        return item as T;
      }),
    ),
  ].sort();
  return result.length ? result : undefined;
}

function instant(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  )
    return invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalid();
  return parsed.toISOString();
}

function normalizeFilters(value: unknown): SearchFilters {
  if (!plain(value) || !exactKeys(value, [], FILTER_KEYS)) return invalid();
  const result: SearchFilters = {};
  const personIds = normalizeUuidSet(value.personIds, 20);
  const factDefinitionIds = normalizeUuidSet(value.factDefinitionIds, 50);
  const relationshipTypeIds = normalizeUuidSet(value.relationshipTypeIds, 50);
  const sourceIds = normalizeUuidSet(value.sourceIds, 50);
  const factStates = normalizeEnumSet(value.factStates, FACT_STATES, 10);
  const relationshipStates = normalizeEnumSet(
    value.relationshipStates,
    RELATIONSHIP_STATES,
    10,
  );
  const sensitivities = normalizeEnumSet(
    value.sensitivities,
    SEARCH_SENSITIVITIES,
    10,
  );
  const at = instant(value.at);
  const from = instant(value.from);
  const until = instant(value.until);
  if (at && (from || until)) return invalid();
  if (from && until && from > until) return invalid();
  if (personIds) result.personIds = personIds;
  if (factDefinitionIds) result.factDefinitionIds = factDefinitionIds;
  if (factStates) result.factStates = factStates;
  if (relationshipTypeIds) result.relationshipTypeIds = relationshipTypeIds;
  if (relationshipStates) result.relationshipStates = relationshipStates;
  if (sourceIds) result.sourceIds = sourceIds;
  if (sensitivities) result.sensitivities = sensitivities;
  if (at) result.at = at;
  if (from) result.from = from;
  if (until) result.until = until;
  return result;
}

function normalizeKinds(value: unknown): SearchResultKind[] {
  const kinds = normalizeEnumSet(
    value,
    SEARCH_RESULT_KINDS,
    SEARCH_RESULT_KINDS.length,
  );
  if (!kinds?.length) return invalid();
  return kinds;
}

function normalizeMatch(value: unknown): NormalizedSearchInput["match"] {
  if (!plain(value) || typeof value.type !== "string") return invalid();
  if (value.type === "text") {
    if (!exactKeys(value, ["type", "query"])) return invalid();
    return { type: "text", query: normalizeSearchText(value.query) };
  }
  if (value.type !== "protectedExact") return invalid();
  if (!exactKeys(value, ["type", "kind", "value"], ["namespace"]))
    return invalid();
  if (
    (value.kind !== "PHONE" && value.kind !== "PERSON_IDENTIFIER") ||
    typeof value.value !== "string" ||
    bytes(value.value) < 1 ||
    bytes(value.value) > 256 ||
    (value.kind === "PHONE" && value.namespace !== undefined) ||
    (value.kind === "PERSON_IDENTIFIER" && typeof value.namespace !== "string")
  )
    return invalid();
  return value.kind === "PHONE"
    ? { type: "protectedExact", kind: "PHONE", value: value.value }
    : {
        type: "protectedExact",
        kind: "PERSON_IDENTIFIER",
        value: value.value,
        namespace: value.namespace as string,
      };
}

export function normalizeSearchInput(value: unknown): NormalizedSearchInput {
  if (
    !plain(value) ||
    !exactKeys(
      value,
      ["version", "match", "kinds", "filters"],
      ["first", "after"],
    ) ||
    value.version !== 1
  )
    return invalid();
  const first = value.first === undefined ? 25 : value.first;
  if (!Number.isInteger(first) || Number(first) < 1) return invalid();
  if (
    value.after !== undefined &&
    value.after !== null &&
    typeof value.after !== "string"
  )
    return invalid();
  return {
    version: 1,
    match: normalizeMatch(value.match),
    kinds: normalizeKinds(value.kinds),
    filters: normalizeFilters(value.filters),
    first: Math.min(Number(first), 100),
    after: typeof value.after === "string" ? value.after : null,
  };
}

function assertJsonBudget(value: unknown): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 200 || depth > 8) return invalid();
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (plain(item)) {
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  };
  visit(value, 1);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (bytes(encoded) > 32 * 1024) return invalid();
}

export function parseSavedSearchAst(value: unknown): SavedSearchAstV1 {
  assertJsonBudget(value);
  if (
    !plain(value) ||
    !exactKeys(value, [
      "schema",
      "version",
      "match",
      "kinds",
      "filters",
      "pageSize",
    ]) ||
    value.schema !== "humans.search-query" ||
    value.version !== 1 ||
    !plain(value.match) ||
    !exactKeys(value.match, ["type", "query"]) ||
    value.match.type !== "text" ||
    !Number.isInteger(value.pageSize) ||
    Number(value.pageSize) < 1 ||
    Number(value.pageSize) > 100
  )
    return invalid("The saved search is invalid.");
  return {
    schema: "humans.search-query",
    version: 1,
    match: { type: "text", query: normalizeSearchText(value.match.query) },
    kinds: normalizeKinds(value.kinds),
    filters: normalizeFilters(value.filters),
    pageSize: Number(value.pageSize),
  };
}

export function canonicalSearchJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalSearchJson(item)).join(",")}]`;
  if (plain(value))
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalSearchJson(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export function hashSavedSearchAst(value: SavedSearchAstV1): string {
  const ast = parseSavedSearchAst(value);
  return createHash("sha256")
    .update("humans:saved-search-ast:v1\0", "utf8")
    .update(canonicalSearchJson(ast), "utf8")
    .digest("hex");
}
