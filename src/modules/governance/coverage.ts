import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";

import {
  consentScopes,
  fieldPolicies,
  purposePolicies,
} from "@/db/schema/governance";
import { factDefinitions } from "@/db/schema/facts";
import { people } from "@/db/schema/people";
import { consentRecords } from "@/db/schema/privacy";
import { legalHolds } from "@/db/schema/workspaces";
import type { ResearchServiceContext } from "@/modules/audit/service";

import type {
  CoverageResult,
  GovernanceScope,
  PurposeCoverageInput,
} from "./types";

type CoveragePolicy = {
  id: string;
  purpose: string;
  lawfulBases: readonly string[];
  caseReference: string | null;
};
type CoverageScope = {
  scope: GovernanceScope;
  fieldDefinitionId: string | null;
  caseReference: string | null;
};
type CoverageConsent = {
  id: string;
  status: "granted" | "withdrawn" | "expired" | "denied" | "unknown";
  lawfulBasis: string | null;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  withdrawnAt: Date | null;
  scopes: readonly CoverageScope[];
};

const sensitivityRank = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
} as const;

function result(
  reason: CoverageResult["reason"],
  consentRecordId: string | null,
  policyId: string | null,
): CoverageResult {
  return {
    allowed: reason === "covered",
    reason,
    consentRecordId,
    policyId,
  };
}

/** Pure evaluation retained for focused, redaction-safe coverage tests. */
export function evaluateCoverage(input: {
  policy: CoveragePolicy | null;
  consent: CoverageConsent | null;
  scope: GovernanceScope;
  fieldDefinitionId?: string | null;
  caseReference?: string | null;
  at: Date;
}): CoverageResult {
  if (!input.policy) return result("missing_consent", null, null);
  if (!input.consent) return result("missing_consent", null, input.policy.id);
  const consent = input.consent;
  if (consent.status === "withdrawn" || consent.withdrawnAt) {
    return result("withdrawn", consent.id, input.policy.id);
  }
  if (
    consent.status === "expired" ||
    consent.effectiveFrom > input.at ||
    (consent.effectiveUntil !== null && consent.effectiveUntil < input.at)
  ) {
    return result("expired", consent.id, input.policy.id);
  }
  if (
    consent.status !== "granted" ||
    !consent.lawfulBasis ||
    !input.policy.lawfulBases.includes(consent.lawfulBasis)
  ) {
    return result("missing_consent", consent.id, input.policy.id);
  }
  if (
    input.policy.caseReference !== null &&
    input.policy.caseReference !== input.caseReference
  ) {
    return result("case_not_permitted", consent.id, input.policy.id);
  }
  const scopes = consent.scopes.filter((scope) => scope.scope === input.scope);
  if (!scopes.length)
    return result("field_not_permitted", consent.id, input.policy.id);
  const fieldMatches = scopes.filter(
    (scope) =>
      scope.fieldDefinitionId === null ||
      scope.fieldDefinitionId === (input.fieldDefinitionId ?? null),
  );
  if (!fieldMatches.length)
    return result("field_not_permitted", consent.id, input.policy.id);
  // Field and case constraints must be satisfied by the same scope row.  A
  // caller omitting either dimension can match only an explicit wildcard.
  const matching = fieldMatches.find(
    (scope) =>
      scope.caseReference === null ||
      scope.caseReference === (input.caseReference ?? null),
  );
  if (!matching)
    return result("case_not_permitted", consent.id, input.policy.id);
  return result("covered", consent.id, input.policy.id);
}

/**
 * Resolves only workspace-scoped governance metadata and returns reason codes;
 * it never returns a protected value or an existence distinction to callers.
 */
export async function checkPurposeCoverage(
  context: Pick<ResearchServiceContext, "database" | "workspaceId">,
  input: PurposeCoverageInput,
): Promise<CoverageResult> {
  const at = input.at ?? new Date();
  const [person] = await context.database
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.workspaceId, context.workspaceId),
        eq(people.id, input.personId),
        isNull(people.deletedAt),
      ),
    )
    .limit(1);
  if (!person) return result("missing_consent", null, null);

  if (input.fieldDefinitionId) {
    const [definition] = await context.database
      .select({
        id: factDefinitions.id,
        sensitivity: factDefinitions.defaultSensitivity,
      })
      .from(factDefinitions)
      .where(
        and(
          eq(factDefinitions.workspaceId, context.workspaceId),
          eq(factDefinitions.id, input.fieldDefinitionId),
          isNull(factDefinitions.deletedAt),
        ),
      )
      .limit(1);
    if (!definition) return result("field_not_permitted", null, null);
  }

  const [hold] = await context.database
    .select({ id: legalHolds.id })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.workspaceId, context.workspaceId),
        eq(legalHolds.resourceKind, "person"),
        eq(legalHolds.resourceId, input.personId),
        eq(legalHolds.state, "active"),
        isNull(legalHolds.deletedAt),
      ),
    )
    .limit(1);
  if (hold) return result("legal_hold", null, null);

  const [policy] = await context.database
    .select()
    .from(purposePolicies)
    .where(
      and(
        eq(purposePolicies.workspaceId, context.workspaceId),
        eq(purposePolicies.purpose, input.purpose),
        eq(purposePolicies.state, "active"),
        isNull(purposePolicies.deletedAt),
        lte(purposePolicies.effectiveFrom, at),
        or(
          isNull(purposePolicies.effectiveUntil),
          gte(purposePolicies.effectiveUntil, at),
        ),
      ),
    )
    // Newest effective policy supersedes older policy rows, including ties.
    .orderBy(
      desc(purposePolicies.effectiveFrom),
      desc(purposePolicies.createdAt),
      desc(purposePolicies.id),
    )
    .limit(1);
  if (!policy) return result("missing_consent", null, null);
  if (
    policy.caseReference !== null &&
    policy.caseReference !== input.caseReference
  ) {
    return result("case_not_permitted", null, policy.id);
  }

  if (input.fieldDefinitionId) {
    const [fieldPolicy] = await context.database
      .select()
      .from(fieldPolicies)
      .where(
        and(
          eq(fieldPolicies.workspaceId, context.workspaceId),
          eq(fieldPolicies.purposePolicyId, policy.id),
          eq(fieldPolicies.fieldDefinitionId, input.fieldDefinitionId),
          isNull(fieldPolicies.deletedAt),
        ),
      )
      .orderBy(desc(fieldPolicies.createdAt), desc(fieldPolicies.id))
      .limit(1);
    if (!fieldPolicy || !fieldPolicy.permittedScopes.includes(input.scope)) {
      return result("field_not_permitted", null, policy.id);
    }
    const [definition] = await context.database
      .select({ sensitivity: factDefinitions.defaultSensitivity })
      .from(factDefinitions)
      .where(
        and(
          eq(factDefinitions.workspaceId, context.workspaceId),
          eq(factDefinitions.id, input.fieldDefinitionId),
          isNull(factDefinitions.deletedAt),
        ),
      )
      .limit(1);
    if (
      !definition ||
      sensitivityRank[fieldPolicy.sensitivityCeiling] <
        sensitivityRank[input.effectiveSensitivity ?? definition.sensitivity]
    ) {
      return result("field_not_permitted", null, policy.id);
    }
    if (
      fieldPolicy.caseReference !== null &&
      fieldPolicy.caseReference !== input.caseReference
    ) {
      return result("case_not_permitted", null, policy.id);
    }
  }

  const consents = await context.database
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.workspaceId, context.workspaceId),
        eq(consentRecords.personId, input.personId),
        eq(consentRecords.purpose, input.purpose),
        isNull(consentRecords.deletedAt),
      ),
    )
    .orderBy(
      consentRecords.effectiveFrom,
      consentRecords.createdAt,
      consentRecords.id,
    );
  if (!consents.length) return result("missing_consent", null, policy.id);
  const consent = consents.at(-1)!;
  const scopes = await context.database
    .select({
      scope: consentScopes.scope,
      fieldDefinitionId: consentScopes.fieldDefinitionId,
      caseReference: consentScopes.caseReference,
    })
    .from(consentScopes)
    .where(
      and(
        eq(consentScopes.workspaceId, context.workspaceId),
        eq(consentScopes.consentRecordId, consent.id),
        isNull(consentScopes.deletedAt),
      ),
    );
  return evaluateCoverage({
    policy,
    consent: { ...consent, scopes },
    scope: input.scope,
    fieldDefinitionId: input.fieldDefinitionId,
    caseReference: input.caseReference,
    at,
  });
}
