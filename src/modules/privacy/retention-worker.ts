import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { privacyRequests } from "@/db/schema/privacy";
import { people } from "@/db/schema/people";
import { legalHolds, retentionPolicies } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { retentionDecision } from "./retention-service";

const MAX_RETENTION_BATCH = 100;
const REVIEW_WINDOW_DAYS = 30;
const WORKER_ACTOR = "worker:retention";
const HMAC_KEY = /^[a-f0-9]{64}$/iu;

export type RetentionResourceCandidate = {
  id: string;
  createdAt: Date;
  held: boolean;
};

export type RetentionCandidatePlan = {
  id: string;
  reason: "retention_elapsed_soft_delete_requires_approval";
};

type RetentionPolicy = {
  id: string;
  retentionDays: number;
  deletionBehavior: string;
};

function retentionPurpose(
  policy: Pick<RetentionPolicy, "id"> & { version: number },
) {
  return `retention:${policy.id}:v${policy.version}`;
}

/**
 * Plans only resources that are expired under a soft-delete policy. Planning
 * never mutates a record: the worker turns these candidates into pending,
 * independently reviewable privacy requests. Active legal holds always win.
 */
export function planRetentionCandidates(input: {
  now: Date;
  policy: RetentionPolicy;
  resources: readonly RetentionResourceCandidate[];
}): RetentionCandidatePlan[] {
  if (!Number.isFinite(input.now.getTime()))
    throw new TypeError("Invalid retention clock");
  if (
    !Number.isSafeInteger(input.policy.retentionDays) ||
    input.policy.retentionDays < 0
  )
    throw new TypeError("Invalid retention policy interval");
  if (input.policy.deletionBehavior !== "soft_delete") return [];

  return input.resources
    .map((resource) => {
      const decision = retentionDecision({
        now: input.now,
        createdAt: resource.createdAt,
        held: resource.held,
        policy: {
          id: input.policy.id,
          retentionDays: input.policy.retentionDays,
          deletionBehavior: input.policy.deletionBehavior,
        },
      });
      return decision.state === "eligible_for_deletion" && !resource.held
        ? { id: resource.id, reason: decision.reason }
        : null;
    })
    .filter((resource): resource is RetentionCandidatePlan => resource !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function hmac(key: string, value: string) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(value)
    .digest("hex");
}

/**
 * Finds expired people/files and queues a deterministic privacy deletion
 * request for each one. It deliberately stops at `requested`: a reviewer must
 * verify the subject-rights request before the existing legal-hold-fenced
 * deletion worker can mutate anything.
 */
export async function enqueueExpiredRetentionRequests(input: {
  database: Database;
  idempotencyHmacKey: string;
  limit?: number;
  now?: Date;
}): Promise<number> {
  const limit = input.limit ?? MAX_RETENTION_BATCH;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETENTION_BATCH)
    throw new TypeError("Invalid retention batch size");
  if (!HMAC_KEY.test(input.idempotencyHmacKey))
    throw new TypeError("Invalid retention idempotency key");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new TypeError("Invalid retention clock");

  const policies = await input.database
    .select({
      id: retentionPolicies.id,
      workspaceId: retentionPolicies.workspaceId,
      resourceKind: retentionPolicies.resourceKind,
      retentionDays: retentionPolicies.retentionDays,
      deletionBehavior: retentionPolicies.deletionBehavior,
      version: retentionPolicies.version,
    })
    .from(retentionPolicies)
    .where(
      and(
        isNull(retentionPolicies.deletedAt),
        eq(retentionPolicies.deletionBehavior, "soft_delete"),
        inArray(retentionPolicies.resourceKind, ["person", "file"]),
      ),
    )
    .orderBy(asc(retentionPolicies.workspaceId), asc(retentionPolicies.id));

  let queued = 0;
  for (const policy of policies) {
    if (queued >= limit) break;
    const remaining = limit - queued;
    await input.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${policy.workspaceId}, 0))`,
      );

      const cutoff = new Date(
        now.getTime() - policy.retentionDays * 86_400_000,
      );
      const resourceRows =
        policy.resourceKind === "person"
          ? await transaction
              .select({ id: people.id, createdAt: people.createdAt })
              .from(people)
              .where(
                and(
                  eq(people.workspaceId, policy.workspaceId),
                  isNull(people.deletedAt),
                  lte(people.createdAt, cutoff),
                  sql`not exists (
                    select 1 from ${privacyRequests}
                    where ${privacyRequests.workspaceId} = ${policy.workspaceId}
                      and ${privacyRequests.requesterId} = ${WORKER_ACTOR}
                      and ${privacyRequests.purpose} = ${retentionPurpose(policy)}
                      and ${privacyRequests.deletedAt} is null
                      and ${privacyRequests.scope}->'personIds' @> jsonb_build_array(${people.id}::text)
                  )`,
                ),
              )
              .orderBy(asc(people.createdAt), asc(people.id))
              .limit(remaining)
          : await transaction
              .select({ id: files.id, createdAt: files.createdAt })
              .from(files)
              .where(
                and(
                  eq(files.workspaceId, policy.workspaceId),
                  isNull(files.deletedAt),
                  lte(files.createdAt, cutoff),
                  sql`not exists (
                    select 1 from ${privacyRequests}
                    where ${privacyRequests.workspaceId} = ${policy.workspaceId}
                      and ${privacyRequests.requesterId} = ${WORKER_ACTOR}
                      and ${privacyRequests.purpose} = ${retentionPurpose(policy)}
                      and ${privacyRequests.deletedAt} is null
                      and ${privacyRequests.scope}->'fileIds' @> jsonb_build_array(${files.id}::text)
                  )`,
                ),
              )
              .orderBy(asc(files.createdAt), asc(files.id))
              .limit(remaining);
      if (!resourceRows.length) return;

      const holdRows = await transaction
        .select({ resourceId: legalHolds.resourceId })
        .from(legalHolds)
        .where(
          and(
            eq(legalHolds.workspaceId, policy.workspaceId),
            eq(legalHolds.resourceKind, policy.resourceKind),
            eq(legalHolds.state, "active"),
            isNull(legalHolds.deletedAt),
            inArray(
              legalHolds.resourceId,
              resourceRows.map((resource) => resource.id),
            ),
          ),
        );
      const plans = planRetentionCandidates({
        now,
        policy,
        resources: resourceRows.map((resource) => ({
          ...resource,
          held: holdRows.some((hold) => hold.resourceId === resource.id),
        })),
      });

      for (const plan of plans) {
        if (queued >= limit) break;
        const scope =
          policy.resourceKind === "person"
            ? { personIds: [plan.id], fileIds: [] }
            : { personIds: [], fileIds: [plan.id] };
        const material = `${policy.workspaceId}:${policy.id}:${policy.version}:${policy.resourceKind}:${plan.id}`;
        const idempotencyHash = hmac(
          input.idempotencyHmacKey,
          `privacy:retention:${material}`,
        );
        const requestHash = hmac(
          input.idempotencyHmacKey,
          JSON.stringify({
            executeAfter: now.toISOString(),
            purpose: retentionPurpose(policy),
            scope,
          }),
        );
        const [existing] = await transaction
          .select({ id: privacyRequests.id })
          .from(privacyRequests)
          .where(
            and(
              eq(privacyRequests.workspaceId, policy.workspaceId),
              eq(privacyRequests.requesterId, WORKER_ACTOR),
              eq(privacyRequests.idempotencyHash, idempotencyHash),
            ),
          )
          .limit(1);
        if (existing) continue;

        const id = newId();
        const dueAt = new Date(now.getTime() + REVIEW_WINDOW_DAYS * 86_400_000);
        const [request] = await transaction
          .insert(privacyRequests)
          .values({
            id,
            workspaceId: policy.workspaceId,
            requestType: "deletion",
            requesterId: WORKER_ACTOR,
            scope,
            purpose: retentionPurpose(policy),
            idempotencyHash,
            requestHash,
            dueAt,
            executeAfter: now,
            createdBy: WORKER_ACTOR,
            updatedBy: WORKER_ACTOR,
          })
          .returning();
        if (!request) throw new Error("Retention request insert failed");

        const auditReference = newId();
        await transaction.insert(auditEvents).values({
          id: auditReference,
          workspaceId: policy.workspaceId,
          actorUserId: null,
          sessionId: null,
          apiKeyId: null,
          action: "privacy.retention.candidate_queued",
          resourceKind: "privacy_request",
          resourceId: request.id,
          requestId: `worker:retention:${policy.id}`,
          redactedDiff: {
            deletionBehavior: policy.deletionBehavior,
            policyId: policy.id,
            reason: plan.reason,
            resourceKind: policy.resourceKind,
          },
          outcome: "success",
        });
        await transaction
          .update(privacyRequests)
          .set({ auditReference })
          .where(
            and(
              eq(privacyRequests.workspaceId, policy.workspaceId),
              eq(privacyRequests.id, request.id),
            ),
          );
        queued += 1;
      }
    });
  }
  return queued;
}
