import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { retentionPolicies } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { consentRecords } from "@/db/schema/privacy";
import { consentScopes, purposePolicies } from "@/db/schema/governance";
import { privacyProcessors } from "./request-types";
import {
  privacyExecutionDigest,
  type PrivacyExecutionContract,
} from "./execution-manifest";

const RETENTION_WORKER = "worker:retention";
const RETENTION_PURPOSE =
  /^retention:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):v([1-9][0-9]*)$/iu;

type RetentionRequestPolicyInput = {
  purpose: string | null;
  requesterId: string;
  requestType: string;
  scope: {
    fileIds: readonly string[];
    personIds: readonly string[];
  };
};

export type RetentionPolicyAction =
  "review" | "soft_delete" | "hard_delete" | "anonymize";
export type RetentionPolicySnapshot = {
  id: string;
  resourceKind: "person" | "file";
  version: number;
  deletionBehavior: RetentionPolicyAction;
};

/**
 * Worker-created retention requests remain bound to the exact active policy
 * snapshot that queued them. Callers hold the workspace policy advisory lock,
 * so a policy mutation cannot race this check and a subsequent destructive
 * transition in the same transaction.
 */
export async function currentRetentionRequestPolicy(
  context: { database: Database; workspaceId: string },
  request: RetentionRequestPolicyInput,
): Promise<RetentionPolicySnapshot | null> {
  if (request.requesterId !== RETENTION_WORKER) return null;
  const purpose = request.purpose?.match(RETENTION_PURPOSE);
  const policyVersion = Number(purpose?.[2]);
  const personRequest =
    request.scope.personIds.length === 1 && request.scope.fileIds.length === 0;
  const fileRequest =
    request.scope.fileIds.length === 1 && request.scope.personIds.length === 0;
  if (
    request.requestType !== "deletion" ||
    !purpose ||
    !Number.isSafeInteger(policyVersion) ||
    (!personRequest && !fileRequest)
  )
    return null;

  const [policy] = await context.database
    .select({
      deletionBehavior: retentionPolicies.deletionBehavior,
      id: retentionPolicies.id,
      resourceKind: retentionPolicies.resourceKind,
      version: retentionPolicies.version,
    })
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.workspaceId, context.workspaceId),
        eq(retentionPolicies.id, purpose[1]!.toLowerCase()),
        eq(retentionPolicies.resourceKind, personRequest ? "person" : "file"),
        eq(retentionPolicies.version, policyVersion),
        isNull(retentionPolicies.deletedAt),
      ),
    )
    .limit(1)
    .for("share");
  if (
    !policy ||
    !["person", "file"].includes(policy.resourceKind) ||
    !["review", "soft_delete", "hard_delete", "anonymize"].includes(
      policy.deletionBehavior,
    )
  )
    return null;
  return policy as RetentionPolicySnapshot;
}

export async function retentionRequestPolicyIsCurrent(
  context: { database: Database; workspaceId: string },
  request: RetentionRequestPolicyInput,
) {
  if (request.requesterId !== RETENTION_WORKER) return true;
  const policy = await currentRetentionRequestPolicy(context, request);
  return Boolean(policy);
}

/** Caller holds the workspace policy lock. These hashes are evidence, not grants. */
export async function currentPrivacyExecutionContract(
  context: { database: Database; workspaceId: string; secret: string },
  request: RetentionRequestPolicyInput & { id: string; caseId: string | null },
): Promise<PrivacyExecutionContract> {
  const kinds = [
    ...(request.scope.personIds.length ? ["person"] : []),
    ...(request.scope.fileIds.length ? ["file"] : []),
  ];
  const policies = await context.database
    .select()
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.workspaceId, context.workspaceId),
        inArray(retentionPolicies.resourceKind, kinds),
        isNull(retentionPolicies.deletedAt),
      ),
    )
    .orderBy(asc(retentionPolicies.id))
    .for("share");
  const purposes = await context.database
    .select()
    .from(purposePolicies)
    .where(
      and(
        eq(purposePolicies.workspaceId, context.workspaceId),
        isNull(purposePolicies.deletedAt),
      ),
    )
    .orderBy(asc(purposePolicies.id))
    .for("share");
  const consents = request.scope.personIds.length
    ? await context.database
        .select()
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.workspaceId, context.workspaceId),
            inArray(consentRecords.personId, [...request.scope.personIds]),
            isNull(consentRecords.deletedAt),
          ),
        )
        .orderBy(asc(consentRecords.id))
        .for("share")
    : [];
  const scopes = consents.length
    ? await context.database
        .select()
        .from(consentScopes)
        .where(
          and(
            eq(consentScopes.workspaceId, context.workspaceId),
            inArray(
              consentScopes.consentRecordId,
              consents.map((row) => row.id),
            ),
            isNull(consentScopes.deletedAt),
          ),
        )
        .orderBy(asc(consentScopes.id))
        .for("share")
    : [];
  const clock = await context.database.execute(
    sql`select clock_timestamp() as now`,
  );
  const now = new Date(String(clock[0]!.now));
  const hash = (domain: string, value: unknown) =>
    privacyExecutionDigest(context.secret, domain, [
      context.workspaceId,
      value,
    ]);
  const policySnapshots = policies.length
    ? policies.map((policy) => ({
        id: policy.id,
        version: policy.version,
        hash: hash("policy", policy),
      }))
    : [
        {
          id: "governed-soft-delete",
          version: 1,
          hash: hash("policy", {
            id: "governed-soft-delete",
            version: 1,
            action: "soft_delete",
          }),
        },
      ];
  return {
    version: 1,
    action: policies.some((p) => p.deletionBehavior === "hard_delete")
      ? "hard_delete"
      : policies.some((p) => p.deletionBehavior === "anonymize")
        ? "anonymize"
        : "soft_delete",
    binding: hash("request", {
      id: request.id,
      requesterId: request.requesterId,
      caseId: request.caseId,
      purpose: request.purpose,
      scope: {
        personIds: [...request.scope.personIds].sort(),
        fileIds: [...request.scope.fileIds].sort(),
      },
    }),
    policies: policySnapshots,
    policyHash: hash("policies", policySnapshots),
    legalBasisDigest: hash("legal-basis", {
      purpose: request.purpose,
      purposes: purposes.map((p) => ({
        ...p,
        currentlyEffective:
          p.effectiveFrom <= now &&
          (!p.effectiveUntil || p.effectiveUntil > now),
      })),
      consents: consents.map((p) => ({
        ...p,
        currentlyEffective:
          p.effectiveFrom <= now &&
          (!p.effectiveUntil || p.effectiveUntil > now),
      })),
      scopes,
    }),
    processorCapabilityVersion: 1,
    requiredProcessors: [...privacyProcessors],
  };
}
