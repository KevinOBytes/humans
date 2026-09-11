import {
  normalizeHumanText,
  validateBoundedJson,
} from "@/modules/facts/validation";
import { createGraphQLError } from "@/graphql/errors";

import {
  governanceScopes,
  lawfulBases,
  type GovernanceScope,
  type GovernanceValidationIssue,
  type GovernanceValidationResult,
  type LawfulBasis,
} from "./types";

const utcRfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

const sensitivities = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export function effectiveGovernanceSensitivity(
  current: string,
  resulting?: string | null,
) {
  const before = sensitivities.indexOf(
    current as (typeof sensitivities)[number],
  );
  const after = sensitivities.indexOf(
    (resulting ?? current) as (typeof sensitivities)[number],
  );
  if (before < 0 || after < 0)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The sensitivity is invalid.",
    );
  return sensitivities[Math.max(before, after)]!;
}

export function approvalTransitionSource(
  state: unknown,
): "requested" | "approved" {
  if (state === "approved" || state === "rejected") return "requested";
  if (state === "revoked") return "approved";
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "The approval transition is invalid.",
  );
}

export function normalizeGovernanceContext(input: {
  governancePurpose?: unknown;
  governanceCaseReference?: unknown;
}) {
  const normalize = (value: unknown, path: string, max: number) => {
    if (value == null) return null;
    const result = normalizeHumanText(value, { path: [path], min: 1, max });
    if (!result.value || result.issues.length)
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The governance context is invalid.",
      );
    return result.value.replace(/\s+/gu, " ");
  };
  return {
    governancePurpose:
      normalize(
        input.governancePurpose,
        "governancePurpose",
        200,
      )?.toLowerCase() ?? null,
    governanceCaseReference: normalize(
      input.governanceCaseReference,
      "governanceCaseReference",
      512,
    ),
  };
}

export function normalizeConsentRecordInput(input: {
  purpose: unknown;
  source: unknown;
  status: unknown;
  lawfulBasis?: unknown;
  effectiveFrom: Date;
  effectiveUntil?: Date | null;
  scopes?: unknown;
  noticeVersion?: unknown;
  collectionMethod?: unknown;
}): GovernanceValidationResult<{
  purpose: string;
  source: string;
  lawfulBasis: LawfulBasis | null;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  noticeVersion: string | null;
  collectionMethod: string | null;
  scopes: {
    scope: GovernanceScope;
    fieldDefinitionId: string | null;
    caseReference: string | null;
  }[];
}> {
  const issues: GovernanceValidationIssue[] = [];
  const scopeRows = input.scopes ?? [];
  if (!Array.isArray(scopeRows) || scopeRows.length > 100)
    return {
      issues: [issue(["scopes"], "INVALID_SCOPE", "The scopes are invalid.")],
    };
  const text = (
    value: unknown,
    path: string[],
    max: number,
    optional = false,
  ) => {
    if (optional && value == null) return null;
    const result = normalizeHumanText(value, { path, min: 1, max });
    issues.push(...result.issues);
    return result.value?.replace(/\s+/gu, " ") ?? null;
  };
  const source = text(input.source, ["source"], 512);
  const noticeVersion = text(input.noticeVersion, ["noticeVersion"], 512, true);
  const collectionMethod = text(
    input.collectionMethod,
    ["collectionMethod"],
    512,
    true,
  );
  const scopes = scopeRows
    .map((row: unknown, index: number) => {
      const path = ["scopes", String(index)];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        issues.push(issue(path, "INVALID_SCOPE", "The scope is invalid."));
        return null;
      }
      const value = row as Record<string, unknown>;
      if (
        Object.keys(value).some(
          (key) =>
            !["scope", "fieldDefinitionId", "caseReference"].includes(key),
        )
      )
        issues.push(issue(path, "INVALID_SCOPE", "The scope is invalid."));
      const scope = normalizedEnum(value.scope, governanceScopes, [
        ...path,
        "scope",
      ]);
      issues.push(...scope.issues);
      const fieldDefinitionId = value.fieldDefinitionId ?? null;
      if (
        fieldDefinitionId !== null &&
        (typeof fieldDefinitionId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            fieldDefinitionId,
          ))
      )
        issues.push(
          issue(
            [...path, "fieldDefinitionId"],
            "INVALID_UUID",
            "The field is invalid.",
          ),
        );
      return {
        scope: scope.value!,
        fieldDefinitionId:
          typeof fieldDefinitionId === "string"
            ? fieldDefinitionId.toLowerCase()
            : null,
        caseReference: text(
          value.caseReference,
          [...path, "caseReference"],
          512,
          true,
        ),
      };
    })
    .filter((scope) => scope !== null);
  // Legacy records can remain non-covering. Explicit scopes always require a lawful basis.
  const normalized = normalizeGovernanceInput({
    purpose: input.purpose,
    scopes: scopes.length ? scopes.map((row) => row.scope) : ["read"],
    lawfulBasis:
      input.lawfulBasis ?? (scopeRows.length ? undefined : "consent"),
    effectiveFrom:
      input.effectiveFrom instanceof Date &&
      !Number.isNaN(input.effectiveFrom.getTime())
        ? input.effectiveFrom.toISOString()
        : "invalid",
    effectiveUntil:
      input.effectiveUntil instanceof Date &&
      !Number.isNaN(input.effectiveUntil.getTime())
        ? input.effectiveUntil.toISOString()
        : input.effectiveUntil,
  });
  issues.push(...normalized.issues);
  if (
    !["granted", "withdrawn", "expired", "denied", "unknown"].includes(
      String(input.status),
    )
  )
    issues.push(
      issue(["status"], "INVALID_ENUM", "The consent status is invalid."),
    );
  if (issues.length || !normalized.value || !source) return { issues };
  const unique = new Map(scopes.map((scope) => [JSON.stringify(scope), scope]));
  return {
    value: {
      purpose: normalized.value.purpose,
      source,
      lawfulBasis:
        input.lawfulBasis == null ? null : normalized.value.lawfulBasis,
      effectiveFrom: normalized.value.effectiveFrom!,
      effectiveUntil: normalized.value.effectiveUntil,
      noticeVersion,
      collectionMethod,
      scopes: [...unique.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, scope]) => scope),
    },
    issues: [],
  };
}

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
