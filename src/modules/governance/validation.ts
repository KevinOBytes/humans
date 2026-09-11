import {
  normalizeHumanText,
  validateBoundedJson,
} from "@/modules/facts/validation";

import {
  governanceScopes,
  lawfulBases,
  type GovernanceScope,
  type GovernanceValidationIssue,
  type GovernanceValidationResult,
  type LawfulBasis,
} from "./types";

const utcRfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function issue(
  path: string[],
  code: string,
  message: string,
): GovernanceValidationIssue {
  return { path, code, message };
}

function normalizedEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string[],
): GovernanceValidationResult<T[number]> {
  const text = normalizeHumanText(value, { path, min: 1, max: 64 });
  if (text.issues.length > 0) return text;
  const normalized = text.value!.toLowerCase().replace(/[\s-]+/gu, "_");
  return (values as readonly string[]).includes(normalized)
    ? { value: normalized as T[number], issues: [] }
    : { issues: [issue(path, "INVALID_ENUM", "The value is not permitted.")] };
}

function normalizedUtc(
  value: unknown,
  path: string[],
): GovernanceValidationResult<Date | null> {
  if (value == null) return { value: null, issues: [] };
  if (typeof value !== "string" || !utcRfc3339.test(value)) {
    return {
      issues: [
        issue(
          path,
          "INVALID_TIMESTAMP",
          "A UTC RFC 3339 timestamp is required.",
        ),
      ],
    };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? {
        issues: [
          issue(
            path,
            "INVALID_TIMESTAMP",
            "A UTC RFC 3339 timestamp is required.",
          ),
        ],
      }
    : { value: parsed, issues: [] };
}

export function validateApprovalReason(
  value: unknown,
): GovernanceValidationResult<string> {
  const normalized = normalizeHumanText(value, {
    path: ["reason"],
    min: 1,
    max: 2_000,
    allowLineBreaks: true,
  });
  return normalized.issues.length
    ? { issues: normalized.issues }
    : { value: normalized.value!.replace(/\s+/gu, " "), issues: [] };
}

export function normalizeGovernanceInput(input: {
  purpose: unknown;
  scopes: unknown;
  lawfulBasis: unknown;
  effectiveFrom?: unknown;
  effectiveUntil?: unknown;
  metadata?: unknown;
}): GovernanceValidationResult<{
  purpose: string;
  scopes: GovernanceScope[];
  lawfulBasis: LawfulBasis;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  metadata: unknown;
}> {
  const issues: GovernanceValidationIssue[] = [];
  const purpose = normalizeHumanText(input.purpose, {
    path: ["purpose"],
    min: 1,
    max: 200,
  });
  const lawfulBasis = normalizedEnum(input.lawfulBasis, lawfulBases, [
    "lawfulBasis",
  ]);
  const effectiveFrom = normalizedUtc(input.effectiveFrom, ["effectiveFrom"]);
  const effectiveUntil = normalizedUtc(input.effectiveUntil, [
    "effectiveUntil",
  ]);
  const metadata = validateBoundedJson(input.metadata ?? {}, {
    objectOnly: true,
    path: ["metadata"],
  });
  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    issues.push(
      issue(["scopes"], "INVALID_SCOPE", "At least one scope is required."),
    );
  }
  const scopes = Array.isArray(input.scopes)
    ? input.scopes.map((value, index) =>
        normalizedEnum(value, governanceScopes, ["scopes", String(index)]),
      )
    : [];
  for (const result of [
    purpose,
    lawfulBasis,
    effectiveFrom,
    effectiveUntil,
    metadata,
    ...scopes,
  ]) {
    if (result.issues.length) issues.push(...result.issues);
  }
  if (
    effectiveFrom.value &&
    effectiveUntil.value &&
    effectiveUntil.value < effectiveFrom.value
  ) {
    issues.push(
      issue(
        ["effectiveUntil"],
        "INVALID_INTERVAL",
        "The effective interval is not ordered.",
      ),
    );
  }
  if (issues.length) return { issues };
  return {
    value: {
      purpose: purpose.value!.replace(/\s+/gu, " ").toLowerCase(),
      scopes: [...new Set(scopes.map((scope) => scope.value!))].sort(),
      lawfulBasis: lawfulBasis.value!,
      effectiveFrom: effectiveFrom.value!,
      effectiveUntil: effectiveUntil.value!,
      metadata: metadata.value!,
    },
    issues: [],
  };
}
