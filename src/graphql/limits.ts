import { createGraphQLError } from "./errors";

export const MAX_REQUEST_BYTES = 262_144;
export const MAX_QUERY_TOKENS = 2_000;
export const MAX_ALIASES = 15;
export const MAX_DEPTH = 10;
export const MAX_BREADTH = 100;
export const MAX_COMPLEXITY = 500;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_API_KEY_LENGTH = 512;

export type PaginationInput = {
  after?: string | null;
  before?: string | null;
  first?: number | null;
  last?: number | null;
};

export type ForwardPagination = {
  after: string | null;
  first: number;
};

const STRICT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STRICT_SELECTION_KEY = /^[a-z][a-z0-9_.-]{0,63}$/u;

const dateCursorOrders = new Set([
  "audit-occurred-desc",
  "evidence-created-desc",
  "excerpt-created-desc",
  "fact-evidence-created-desc",
  "fact-relationship-created-desc",
  "facts-asserted-desc",
  "note-updated-desc",
  "relationship-created-desc",
  "relationship-evidence-created-desc",
  "source-created-desc",
  "person-names-created-desc",
  "person-events-created-desc",
  "contradictory-facts-asserted-desc",
]);

export function decodeResearchCursor(
  value: string | null | undefined,
  order: string,
): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid wrapper");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      throw new Error("non-canonical wrapper");
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      decoded.v !== 1 ||
      decoded.o !== order ||
      typeof decoded.i !== "string" ||
      !STRICT_UUID.test(decoded.i)
    )
      throw new Error("invalid");
    if (dateCursorOrders.has(order)) {
      if (typeof decoded.t !== "string") throw new Error("invalid");
      const timestamp = new Date(decoded.t);
      if (
        Number.isNaN(timestamp.getTime()) ||
        timestamp.toISOString() !== decoded.t
      )
        throw new Error("invalid");
    } else if (order === "person-field-selection-key-asc") {
      if (
        typeof decoded.n !== "string" ||
        typeof decoded.k !== "string" ||
        !STRICT_SELECTION_KEY.test(decoded.n) ||
        !STRICT_SELECTION_KEY.test(decoded.k)
      )
        throw new Error("invalid");
    } else if (
      order === "fact-definition-key-asc" ||
      order === "relationship-type-key-asc"
    ) {
      if (typeof decoded.n !== "string" || typeof decoded.k !== "string")
        throw new Error("invalid");
    } else if (order === "tag-name-asc" || order === "subject-tag-name-asc") {
      if (typeof decoded.n !== "string") throw new Error("invalid");
    } else if (order === "fact-revision-desc") {
      if (!Number.isInteger(decoded.r) || (decoded.r as number) < 1)
        throw new Error("invalid");
    } else if (order === "people-name-asc") {
      if (typeof decoded.s !== "string") throw new Error("invalid");
    } else {
      throw new Error("invalid");
    }
    return decoded;
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

export function normalizePagination(input: PaginationInput): ForwardPagination {
  if (input.before != null || input.last != null) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Backward pagination is not supported.",
    );
  }
  const first = input.first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      `first must be between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  return { after: input.after ?? null, first };
}
