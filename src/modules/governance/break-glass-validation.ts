import { createGraphQLError } from "@/graphql/errors";
import { normalizeHumanText } from "@/modules/facts/validation";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/** Break-glass never grants a workspace-wide or untyped bypass. */
export const breakGlassResourceKinds = [
  "person",
  "fact",
  "relationship",
  "evidence",
  "source",
  "file",
  "address",
  "contact_point",
  "place",
  "note",
] as const;

export type BreakGlassResourceKind = (typeof breakGlassResourceKinds)[number];

const maxDurationMs = 7 * 24 * 60 * 60 * 1_000;

function text(value: unknown, label: string, min: number, max: number): string {
  const result = normalizeHumanText(value, { path: [label], min, max });
  if (!result.value || result.issues.length) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      `The break-glass ${label} is invalid.`,
    );
  }
  return result.value.replace(/\s+/gu, " ");
}

function expiresAt(value: unknown): Date {
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !RFC3339.test(raw)) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The break-glass expiry is invalid.",
    );
  }
  const parsed = new Date(raw);
  const now = Date.now();
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getTime() <= now ||
    parsed.getTime() > now + maxDurationMs
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The break-glass expiry is invalid.",
    );
  }
  return parsed;
}

export function normalizeBreakGlassRequest(input: {
  purpose: unknown;
  justification: unknown;
  expiresAt: unknown;
  caseReference?: unknown;
}) {
  return {
    purpose: text(input.purpose, "purpose", 1, 200).toLowerCase(),
    justification: text(input.justification, "justification", 20, 4_000),
    expiresAt: expiresAt(input.expiresAt),
    caseReference:
      input.caseReference == null
        ? null
        : text(input.caseReference, "case reference", 1, 512),
  } as const;
}

export function normalizeBreakGlassResources(
  input: unknown,
): { resourceKind: BreakGlassResourceKind; resourceId: string }[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The break-glass resource list is invalid.",
    );
  }
  const allowed = new Set<string>(breakGlassResourceKinds);
  const resources = new Map<
    string,
    { resourceKind: BreakGlassResourceKind; resourceId: string }
  >();
  for (const candidate of input) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The break-glass resource list is invalid.",
      );
    }
    const value = candidate as Record<string, unknown>;
    const resourceKind =
      typeof value.resourceKind === "string"
        ? value.resourceKind.trim().toLowerCase()
        : "";
    const resourceId =
      typeof value.resourceId === "string"
        ? value.resourceId.trim().toLowerCase()
        : "";
    if (!allowed.has(resourceKind) || !UUID.test(resourceId)) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The break-glass resource list is invalid.",
      );
    }
    resources.set(`${resourceKind}:${resourceId}`, {
      resourceKind: resourceKind as BreakGlassResourceKind,
      resourceId,
    });
  }
  return [...resources.values()];
}
