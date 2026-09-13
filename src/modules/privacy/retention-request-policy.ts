import { and, eq, isNull } from "drizzle-orm";

import { retentionPolicies } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";

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

/**
 * Worker-created retention requests remain bound to the exact active policy
 * snapshot that queued them. Callers hold the workspace policy advisory lock,
 * so a policy mutation cannot race this check and a subsequent destructive
 * transition in the same transaction.
 */
export async function retentionRequestPolicyIsCurrent(
  context: { database: Database; workspaceId: string },
  request: RetentionRequestPolicyInput,
) {
  if (request.requesterId !== RETENTION_WORKER) return true;
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
    return false;

  const [policy] = await context.database
    .select({ id: retentionPolicies.id })
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.workspaceId, context.workspaceId),
        eq(retentionPolicies.id, purpose[1]!.toLowerCase()),
        eq(retentionPolicies.resourceKind, personRequest ? "person" : "file"),
        eq(retentionPolicies.version, policyVersion),
        eq(retentionPolicies.deletionBehavior, "soft_delete"),
        isNull(retentionPolicies.deletedAt),
      ),
    )
    .limit(1)
    .for("share");
  return Boolean(policy);
}
