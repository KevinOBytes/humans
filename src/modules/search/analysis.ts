import { createHash } from "node:crypto";

import { createGraphQLError } from "@/graphql/errors";

/**
 * A deliberately small, provider-neutral read model for research analysis.
 * Callers must build this model from workspace-authorized rows. The functions
 * in this file do not widen visibility; they only apply additional filters and
 * redact values before returning an analysis result.
 */
export type ResearchAnalysisKind =
  | "TIMELINE"
  | "SOURCE_COMPARISON"
  | "DUPLICATE_CANDIDATES"
  | "CONTRADICTIONS"
  | "GRAPH_METRICS";

export type ResearchFacetInput = Readonly<{
  caseId?: string;
  sensitivity?: readonly (
    "public" | "internal" | "confidential" | "restricted"
  )[];
  consentStatus?: readonly string[];
  sourceReliability?: { min?: number; max?: number };
  temporalRange?: { from?: string; until?: string };
  reviewState?: readonly string[];
  relationshipState?: readonly string[];
}>;

export type ResearchAnalysisRow = Readonly<{
  id: string;
  workspaceId: string;
  kind?: string;
  title?: string | null;
  value?: unknown;
  subjectPersonId?: string | null;
  sourcePersonId?: string | null;
  targetPersonId?: string | null;
  caseId?: string | null;
  sensitivity?: string | null;
  consentStatus?: string | null;
  sourceReliability?: number | string | null;
  validFrom?: string | Date | null;
  validUntil?: string | Date | null;
  observedAt?: string | Date | null;
  reviewState?: string | null;
  relationshipState?: string | null;
  sourceId?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  fieldKey?: string | null;
  duplicateKey?: string | null;
}> &
  Record<string, unknown>;

export type AnalysisContext = Readonly<{
  workspaceId: string;
  purpose: string;
  caseId?: string | null;
  allowedSensitivity?: "public" | "internal" | "confidential" | "restricted";
  maxRows?: number;
}>;

export type AnalysisResult = Readonly<{
  kind: ResearchAnalysisKind;
  rows: readonly Record<string, unknown>[];
  appliedFilters: ResearchFacetInput;
  limit: number;
  redactedFieldCount: number;
  explanation: Readonly<{
    sourceRows: number;
    returnedRows: number;
    timeWindow: { from: string | null; until: string | null };
    filters: ResearchFacetInput;
    omittedFields: readonly string[];
    methodology: string;
  }>;
}>;

const SENSITIVITY_ORDER = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
const MAX_ROWS = 500;

function invalid(message: string): never {
  throw createGraphQLError("VALIDATION_FAILED", message);
}

function timestamp(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function sensitivityAllowed(
  row: ResearchAnalysisRow,
  allowed: AnalysisContext["allowedSensitivity"],
): boolean {
  if (!row.sensitivity || !allowed) return true;
  return (
    SENSITIVITY_ORDER.indexOf(
      row.sensitivity as (typeof SENSITIVITY_ORDER)[number],
    ) <= SENSITIVITY_ORDER.indexOf(allowed)
  );
}

export function normalizeResearchFacets(
  input: ResearchFacetInput = {},
): ResearchFacetInput {
  const sensitivities = [...new Set(input.sensitivity ?? [])];
  const reviewState = [...new Set(input.reviewState ?? [])];
  const relationshipState = [...new Set(input.relationshipState ?? [])];
  const consentStatus = [...new Set(input.consentStatus ?? [])];
  const range = input.temporalRange;
  if (range?.from && !Number.isFinite(Date.parse(range.from)))
    invalid("The temporal range start is invalid.");
  if (range?.until && !Number.isFinite(Date.parse(range.until)))
    invalid("The temporal range end is invalid.");
  if (
    range?.from &&
    range?.until &&
    Date.parse(range.from) > Date.parse(range.until)
  )
    invalid("The temporal range is inverted.");
  const reliability = input.sourceReliability;
  if (
    reliability?.min != null &&
    (!Number.isFinite(reliability.min) ||
      reliability.min < 0 ||
      reliability.min > 1)
  )
    invalid("The minimum source reliability is invalid.");
  if (
    reliability?.max != null &&
    (!Number.isFinite(reliability.max) ||
      reliability.max < 0 ||
      reliability.max > 1)
  )
    invalid("The maximum source reliability is invalid.");
  if (
    reliability?.min != null &&
    reliability?.max != null &&
    reliability.min > reliability.max
  )
    invalid("The source reliability range is inverted.");
  return {
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(sensitivities.length ? { sensitivity: sensitivities } : {}),
    ...(consentStatus.length ? { consentStatus } : {}),
    ...(reliability ? { sourceReliability: { ...reliability } } : {}),
    ...(range ? { temporalRange: { ...range } } : {}),
    ...(reviewState.length ? { reviewState } : {}),
    ...(relationshipState.length ? { relationshipState } : {}),
  };
}

export function filterResearchRows(
  rows: readonly ResearchAnalysisRow[],
  context: AnalysisContext,
  facets: ResearchFacetInput = {},
): readonly ResearchAnalysisRow[] {
  if (!context.workspaceId || !context.purpose.trim())
    invalid("A workspace and purpose are required.");
  const normalized = normalizeResearchFacets(facets);
  const from = normalized.temporalRange?.from
    ? Date.parse(normalized.temporalRange.from)
    : null;
  const until = normalized.temporalRange?.until
    ? Date.parse(normalized.temporalRange.until)
    : null;
  return rows
    .filter((row) => row.workspaceId === context.workspaceId)
    .filter((row) => sensitivityAllowed(row, context.allowedSensitivity))
    .filter((row) => !normalized.caseId || row.caseId === normalized.caseId)
    .filter(
      (row) =>
        !normalized.sensitivity?.length ||
        normalized.sensitivity.includes(
          (row.sensitivity ?? "") as (typeof SENSITIVITY_ORDER)[number],
        ),
    )
    .filter(
      (row) =>
        !normalized.consentStatus?.length ||
        normalized.consentStatus.includes(row.consentStatus ?? ""),
    )
    .filter((row) => {
      const value =
        row.sourceReliability == null ? null : Number(row.sourceReliability);
      return (
        (normalized.sourceReliability?.min == null ||
          (value != null && value >= normalized.sourceReliability.min)) &&
        (normalized.sourceReliability?.max == null ||
          (value != null && value <= normalized.sourceReliability.max))
      );
    })
    .filter(
      (row) =>
        !normalized.reviewState?.length ||
        normalized.reviewState.includes(row.reviewState ?? ""),
    )
    .filter(
      (row) =>
        !normalized.relationshipState?.length ||
        normalized.relationshipState.includes(row.relationshipState ?? ""),
    )
    .filter((row) => {
      const start = timestamp(row.validFrom ?? row.observedAt);
      const end = timestamp(row.validUntil ?? row.observedAt) ?? start;
      return (
        (from == null || (end != null && end >= from)) &&
        (until == null || (start != null && start <= until))
      );
    })
    .slice(0, Math.min(Math.max(context.maxRows ?? MAX_ROWS, 1), MAX_ROWS));
}

function safeValue(
  row: ResearchAnalysisRow,
  context: AnalysisContext,
): { value: unknown; redacted: boolean } {
  if (!sensitivityAllowed(row, context.allowedSensitivity))
    return { value: null, redacted: true };
  return { value: row.value ?? null, redacted: false };
}

function projectRow(
  row: ResearchAnalysisRow,
  context: AnalysisContext,
): { row: Record<string, unknown>; redacted: number; omitted: string[] } {
  const projected: Record<string, unknown> = {
    id: row.id,
    kind: row.kind ?? null,
    subjectPersonId: row.subjectPersonId ?? null,
  };
  let redacted = 0;
  const omitted: string[] = [];
  const safe = safeValue(row, context);
  if (safe.redacted) {
    redacted += 1;
    omitted.push(row.fieldKey ?? "value");
  } else projected.value = safe.value;
  for (const field of [
    "title",
    "caseId",
    "sensitivity",
    "consentStatus",
    "reviewState",
    "relationshipState",
    "sourceId",
    "sourceTitle",
    "sourceUrl",
    "validFrom",
    "validUntil",
    "observedAt",
    "sourceReliability",
    "fieldKey",
    "duplicateKey",
  ] as const) {
    if (
      row[field] !== undefined &&
      sensitivityAllowed(row, context.allowedSensitivity)
    )
      projected[field] = row[field] ?? null;
  }
  return { row: projected, redacted, omitted };
}

function result(
  kind: ResearchAnalysisKind,
  sourceRows: readonly ResearchAnalysisRow[],
  filteredRows: readonly ResearchAnalysisRow[],
  context: AnalysisContext,
  facets: ResearchFacetInput,
  rows: readonly Record<string, unknown>[],
  redactedFieldCount: number,
  omittedFields: readonly string[],
  methodology: string,
): AnalysisResult {
  const range = facets.temporalRange;
  return {
    kind,
    rows,
    appliedFilters: facets,
    limit: Math.min(Math.max(context.maxRows ?? MAX_ROWS, 1), MAX_ROWS),
    redactedFieldCount,
    explanation: {
      sourceRows: sourceRows.length,
      returnedRows: filteredRows.length,
      timeWindow: { from: range?.from ?? null, until: range?.until ?? null },
      filters: facets,
      omittedFields: [...new Set(omittedFields)].sort(),
      methodology,
    },
  };
}

export function analyzeResearch(input: {
  kind: ResearchAnalysisKind;
  rows: readonly ResearchAnalysisRow[];
  context: AnalysisContext;
  facets?: ResearchFacetInput;
}): AnalysisResult {
  const facets = normalizeResearchFacets(input.facets);
  const filtered = filterResearchRows(input.rows, input.context, facets);
  const projected = filtered.map((row) => projectRow(row, input.context));
  const omitted = projected.flatMap((item) => item.omitted);
  const visible = projected.map((item) => item.row);
  if (input.kind === "TIMELINE") {
    visible.sort(
      (left, right) =>
        (timestamp(String(left.observedAt ?? left.validFrom ?? "")) ?? 0) -
        (timestamp(String(right.observedAt ?? right.validFrom ?? "")) ?? 0),
    );
    return result(
      input.kind,
      input.rows,
      filtered,
      input.context,
      facets,
      visible,
      projected.reduce((sum, item) => sum + item.redacted, 0),
      omitted,
      "Rows are ordered by observed date, then validity start; filters are applied before ordering.",
    );
  }
  if (input.kind === "SOURCE_COMPARISON") {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of visible) {
      const key =
        row.subjectPersonId && row.fieldKey
          ? `${row.subjectPersonId}:${row.fieldKey}`
          : String(row.id);
      const values = groups.get(key) ?? [];
      values.push(row);
      groups.set(key, values);
    }
    const compared = [...groups.entries()].map(([key, values]) => ({
      key,
      sources: values.map((value) => ({
        sourceId: value.sourceId ?? null,
        sourceTitle: value.sourceTitle ?? null,
        sourceUrl: value.sourceUrl ?? null,
        value: value.value ?? null,
        reliability: value.sourceReliability ?? null,
      })),
      sourceCount: new Set(
        values.flatMap((value) => (value.sourceId ? [value.sourceId] : [])),
      ).size,
    }));
    return result(
      input.kind,
      input.rows,
      filtered,
      input.context,
      facets,
      compared,
      projected.reduce((sum, item) => sum + item.redacted, 0),
      omitted,
      "Values are grouped by field and subject so reviewers can compare source provenance; no source is preferred automatically.",
    );
  }
  if (input.kind === "DUPLICATE_CANDIDATES") {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of visible) {
      const key = String(row.duplicateKey ?? row.title ?? row.value ?? row.id)
        .trim()
        .toLocaleLowerCase("und");
      const values = groups.get(key) ?? [];
      values.push(row);
      groups.set(key, values);
    }
    const duplicates = [...groups.entries()]
      .filter(([, values]) => values.length > 1)
      .map(([key, values]) => ({
        keyHash: createHash("sha256").update(key).digest("hex"),
        candidateIds: values.map((value) => value.id),
        reason: "normalized value matches; human review required",
      }));
    return result(
      input.kind,
      input.rows,
      filtered,
      input.context,
      facets,
      duplicates,
      projected.reduce((sum, item) => sum + item.redacted, 0),
      omitted,
      "Candidates use normalized duplicate keys only and never merge records automatically.",
    );
  }
  if (input.kind === "CONTRADICTIONS") {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of visible) {
      if (!row.subjectPersonId || !row.fieldKey || row.value == null) continue;
      const key = `${row.subjectPersonId ?? ""}:${row.fieldKey ?? ""}`;
      const values = groups.get(key) ?? [];
      values.push(row);
      groups.set(key, values);
    }
    const contradictions = [...groups.entries()]
      .filter(
        ([, values]) =>
          new Set(values.map((value) => JSON.stringify(value.value))).size > 1,
      )
      .map(([key, values]) => ({
        key,
        values: values.map((value) => ({
          id: value.id,
          value: value.value ?? null,
          sourceId: value.sourceId ?? null,
          sourceTitle: value.sourceTitle ?? null,
        })),
        reason: "multiple asserted values require reviewer adjudication",
      }));
    return result(
      input.kind,
      input.rows,
      filtered,
      input.context,
      facets,
      contradictions,
      projected.reduce((sum, item) => sum + item.redacted, 0),
      omitted,
      "Contradictions are reported when the same subject and field have different asserted values; no adverse inference is made.",
    );
  }
  const degree = new Map<string, { inDegree: number; outDegree: number }>();
  const seen = new Set<string>();
  for (const row of filtered) {
    if (
      row.kind !== "RELATIONSHIP" ||
      !row.sourcePersonId ||
      !row.targetPersonId ||
      seen.has(row.id)
    )
      continue;
    seen.add(row.id);
    const source = degree.get(row.sourcePersonId) ?? {
      inDegree: 0,
      outDegree: 0,
    };
    source.outDegree += 1;
    degree.set(row.sourcePersonId, source);
    const target = degree.get(row.targetPersonId) ?? {
      inDegree: 0,
      outDegree: 0,
    };
    target.inDegree += 1;
    degree.set(row.targetPersonId, target);
  }
  const metrics = [...degree.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([personId, value]) => ({
      personId,
      ...value,
      degree: value.inDegree + value.outDegree,
      explanation:
        "unique visible relationship IDs incident to this person; a self-loop contributes one incoming and one outgoing edge",
    }));
  return result(
    input.kind,
    input.rows,
    filtered,
    input.context,
    facets,
    metrics,
    projected.reduce((sum, item) => sum + item.redacted, 0),
    omitted,
    "Directed degree counts unique visible, filtered relationship IDs in this bounded search sample, not the complete workspace graph. Facts and evidence do not add edges. It is not a threat, risk, or adverse score.",
  );
}

export const MAX_RESEARCH_ANALYSIS_ROWS = MAX_ROWS;
