import { and, eq, isNull, or, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import { privacyExecutionOutcomes, privacyRequests } from "@/db/schema/privacy";
import type { Database } from "@/modules/auth/bootstrap-admin";
import type { PrivacyExecutionManifest } from "./execution-manifest";

type Outcome = typeof privacyExecutionOutcomes.$inferSelect;
export type PrivacyExecutionClaim = Pick<
  Outcome,
  "id" | "workspaceId" | "privacyRequestId" | "generation"
>;
const identity = (claim: PrivacyExecutionClaim) =>
  and(
    eq(privacyExecutionOutcomes.workspaceId, claim.workspaceId),
    eq(privacyExecutionOutcomes.id, claim.id),
    eq(privacyExecutionOutcomes.privacyRequestId, claim.privacyRequestId),
    eq(privacyExecutionOutcomes.generation, claim.generation),
  );
const liveClaim = (claim: PrivacyExecutionClaim) =>
  and(
    identity(claim),
    eq(privacyExecutionOutcomes.state, "claimed"),
    sql`${privacyExecutionOutcomes.claimExpiresAt} > clock_timestamp()`,
  );

/** Internal worker boundary; no caller clock and no provider I/O under this lease. */
export async function claimPrivacyExecution(
  database: Database,
  workspaceId: string,
  requestId: string,
): Promise<Outcome | null> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`,
    );
    const [request] = await transaction
      .select()
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.workspaceId, workspaceId),
          eq(privacyRequests.id, requestId),
          isNull(privacyRequests.deletedAt),
        ),
      )
      .for("update");
    if (!request) return null;
    const [existing] = await transaction
      .select()
      .from(privacyExecutionOutcomes)
      .where(
        and(
          eq(privacyExecutionOutcomes.workspaceId, workspaceId),
          eq(privacyExecutionOutcomes.privacyRequestId, requestId),
        ),
      )
      .for("update");
    if (existing?.state === "completed" || existing?.state === "rejected")
      return existing;
    if (
      request.requestType !== "deletion" ||
      request.state !== "fulfilling" ||
      request.idempotencyHash.startsWith("legacy:")
    )
      return null;
    if (!existing)
      await transaction
        .insert(privacyExecutionOutcomes)
        .values({ id: newId(), workspaceId, privacyRequestId: requestId });
    const [claimed] = await transaction
      .update(privacyExecutionOutcomes)
      .set({
        state: "claimed",
        generation: sql`${privacyExecutionOutcomes.generation} + 1`,
        claimExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(privacyExecutionOutcomes.workspaceId, workspaceId),
          eq(privacyExecutionOutcomes.privacyRequestId, requestId),
          or(
            eq(privacyExecutionOutcomes.state, "pending"),
            and(
              eq(privacyExecutionOutcomes.state, "claimed"),
              sql`${privacyExecutionOutcomes.claimExpiresAt} <= clock_timestamp()`,
            ),
          ),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

/** Must be called inside the same transaction as every resource mutation. */
export async function assertPrivacyExecutionClaim(
  database: Database,
  claim: PrivacyExecutionClaim,
) {
  const [row] = await database
    .select({ id: privacyExecutionOutcomes.id })
    .from(privacyExecutionOutcomes)
    .where(liveClaim(claim))
    .for("update");
  if (!row) throw new Error("Privacy execution claim is stale");
}

/** Terminal state and its already-inserted redacted audit commit atomically. */
export async function finishPrivacyExecution(
  database: Database,
  claim: PrivacyExecutionClaim,
  result: {
    state: "completed" | "rejected";
    resultCode: string;
    auditReference: string;
    manifest: PrivacyExecutionManifest;
  },
) {
  const [row] = await database
    .update(privacyExecutionOutcomes)
    .set({
      ...result,
      claimExpiresAt: null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(liveClaim(claim))
    .returning();
  if (!row) throw new Error("Privacy execution claim is stale");
  return row;
}

/** A hold/policy pause releases only this generation; terminal receipts never reset. */
export async function releasePrivacyExecution(
  database: Database,
  claim: PrivacyExecutionClaim,
) {
  await database
    .update(privacyExecutionOutcomes)
    .set({
      state: "pending",
      claimExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(identity(claim), eq(privacyExecutionOutcomes.state, "claimed")));
}
