import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/graphql/limits";
import type { OperationLimitPolicy } from "@/graphql/operation-limiter";

const MAX_SNAPSHOT_ROOTS = 10_000;
const MAX_SNAPSHOT_PEOPLE = 10_000;
const MAX_SNAPSHOT_RELATIONSHIPS = 25_000;
const RELATIONSHIP_AUTHORIZATION_LOOKUPS = 4;
const AUTHORIZATION_WORK_PER_TOKEN = 25;

export const ANALYSIS_READ_OPERATION_CLASS = "graph.analysis.read";

// A relationship authorization checks the relationship, its active type, and
// both live endpoints. Roots and the person manifest are checked independently.
// Costs are expressed in conservative groups of 25 authorization lookups.
export const ANALYSIS_MANIFEST_AUTHORIZATION_COST = Math.ceil(
  (MAX_SNAPSHOT_ROOTS +
    MAX_SNAPSHOT_PEOPLE +
    MAX_SNAPSHOT_RELATIONSHIPS * RELATIONSHIP_AUTHORIZATION_LOOKUPS) /
    AUTHORIZATION_WORK_PER_TOKEN,
);

export const ANALYSIS_READ_POLICY: OperationLimitPolicy = {
  capacity: 500_000,
  refillAmount: 500_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
};

export const ANALYSIS_READ_CLIENT_POLICY: OperationLimitPolicy = {
  capacity: 500_000,
  refillAmount: 500_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
};

export function analysisRunReadCost(): number {
  return ANALYSIS_MANIFEST_AUTHORIZATION_COST;
}

export function analysisRunListReadCost(first: number): number {
  return ANALYSIS_MANIFEST_AUTHORIZATION_COST * (first + 1);
}

export function analysisResultReadCost(first: number): number {
  return ANALYSIS_MANIFEST_AUTHORIZATION_COST + first;
}

const ANALYSIS_AUTHORIZATION_COMPLEXITY = 240;
const ANALYSIS_EXPORT_AUTHORIZATION_COMPLEXITY = 350;
const ANALYSIS_EXPORT_LIMIT = 1_000;
const ANALYSIS_EXPORT_ROWS_PER_COMPLEXITY_POINT = 10;
const REJECTED_ANALYSIS_EXPORT_COMPLEXITY = 501;

function boundedComplexityPageSize(first: number | null | undefined): number {
  return first == null
    ? DEFAULT_PAGE_SIZE
    : Number.isInteger(first) && first >= 1 && first <= MAX_PAGE_SIZE
      ? first
      : MAX_PAGE_SIZE;
}

export function analysisRunReadComplexity(): number {
  return ANALYSIS_AUTHORIZATION_COMPLEXITY;
}

export function analysisRunListComplexity(
  first: number | null | undefined,
): number {
  return (
    ANALYSIS_AUTHORIZATION_COMPLEXITY +
    (boundedComplexityPageSize(first) + 1) * 2
  );
}

export function analysisResultReadComplexity(
  first: number | null | undefined,
): number {
  return ANALYSIS_AUTHORIZATION_COMPLEXITY + boundedComplexityPageSize(first);
}

export function analysisExportComplexity(first?: number | null): number {
  const size = first ?? ANALYSIS_EXPORT_LIMIT;
  if (!Number.isInteger(size) || size < 1 || size > ANALYSIS_EXPORT_LIMIT) {
    return REJECTED_ANALYSIS_EXPORT_COMPLEXITY;
  }
  return (
    ANALYSIS_EXPORT_AUTHORIZATION_COMPLEXITY +
    Math.ceil(size / ANALYSIS_EXPORT_ROWS_PER_COMPLEXITY_POINT)
  );
}
