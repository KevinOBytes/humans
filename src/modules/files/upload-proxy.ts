import { and, eq, lte, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { uploadSessions } from "@/db/schema/files";
import type { ProxyUploadAuthorization } from "@/lib/storage/proxy";
import type { Database } from "@/modules/auth/bootstrap-admin";

import { uploadMaxBytesForDeployment, type FileDeploymentMode } from "./limits";
import type { UploadPurpose } from "./types";

const uploadPurposes = new Set<UploadPurpose>([
  "EVIDENCE",
  "CSV_IMPORT",
  "JSON_IMPORT",
]);
const cleanupAttemptTerminalStates = [
  "rejected",
  "expired",
  "cleanup_pending",
] as const;
const MUTATION_SETTLEMENT_INTERVAL = sql`interval '60 seconds'`;

function requiresObjectCleanup(state: string): boolean {
  return cleanupAttemptTerminalStates.some((candidate) => candidate === state);
}

export function createUploadSessionProxyExecutor(input: {
  database: Database;
  deploymentMode: FileDeploymentMode;
}) {
  return async (
    grant: ProxyUploadAuthorization,
    upload: () => Promise<void>,
  ): Promise<boolean> => {
    const attemptId = newId();
    const claimed = await input.database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({
          actorId: uploadSessions.actorId,
          attemptAvailable: sql<boolean>`(${uploadSessions.uploadAttemptId} IS NULL OR ${uploadSessions.uploadAttemptExpiresAt} <= clock_timestamp()) AND (${uploadSessions.storageMutationSettlesAt} IS NULL OR ${uploadSessions.storageMutationSettlesAt} <= clock_timestamp())`,
          expectedChecksum: uploadSessions.expectedChecksum,
          expectedMediaType: uploadSessions.expectedMediaType,
          expiresAt: uploadSessions.expiresAt,
          intendedPurpose: uploadSessions.intendedPurpose,
          maxBytes: uploadSessions.maxBytes,
          notExpired: sql<boolean>`${uploadSessions.expiresAt} > clock_timestamp()`,
          objectKey: uploadSessions.objectKey,
          state: uploadSessions.state,
        })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, grant.workspaceId),
            eq(uploadSessions.id, grant.uploadSessionId),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !session ||
        session.actorId !== grant.actorId ||
        session.objectKey !== grant.key ||
        session.state !== "pending" ||
        !session.notExpired ||
        !session.attemptAvailable ||
        grant.expiresAt.getTime() > session.expiresAt.getTime() ||
        session.maxBytes !== grant.bytes ||
        session.expectedMediaType !== grant.contentType ||
        session.expectedChecksum !== grant.checksumSha256 ||
        !uploadPurposes.has(session.intendedPurpose as UploadPurpose)
      ) {
        return false;
      }
      const purpose = session.intendedPurpose as UploadPurpose;
      if (
        session.maxBytes >
        uploadMaxBytesForDeployment(purpose, input.deploymentMode)
      ) {
        return false;
      }
      const [claim] = await transaction
        .update(uploadSessions)
        .set({
          uploadAttemptId: attemptId,
          uploadAttemptExpiresAt: sql`LEAST(${uploadSessions.expiresAt}, clock_timestamp() + interval '60 seconds')`,
          storageMutationSettlesAt: sql`clock_timestamp() + interval '120 seconds'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(uploadSessions.workspaceId, grant.workspaceId),
            eq(uploadSessions.id, grant.uploadSessionId),
            eq(uploadSessions.state, "pending"),
            or(
              sql`${uploadSessions.uploadAttemptId} IS NULL`,
              lte(
                uploadSessions.uploadAttemptExpiresAt,
                sql`clock_timestamp()`,
              ),
            ),
            or(
              sql`${uploadSessions.storageMutationSettlesAt} IS NULL`,
              lte(
                uploadSessions.storageMutationSettlesAt,
                sql`clock_timestamp()`,
              ),
            ),
          ),
        )
        .returning({ id: uploadSessions.id });
      return Boolean(claim);
    });
    if (!claimed) return false;

    try {
      await upload();
    } catch (error) {
      await recordAmbiguousMutation(input.database, grant, attemptId);
      throw error;
    }

    return input.database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({
          attemptNotExpired: sql<boolean>`${uploadSessions.uploadAttemptExpiresAt} > clock_timestamp()`,
          cleanupCompletedAt: uploadSessions.cleanupCompletedAt,
          sessionNotExpired: sql<boolean>`${uploadSessions.expiresAt} > clock_timestamp()`,
          state: uploadSessions.state,
          uploadAttemptId: uploadSessions.uploadAttemptId,
        })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.workspaceId, grant.workspaceId),
            eq(uploadSessions.id, grant.uploadSessionId),
          ),
        )
        .limit(1)
        .for("update");
      if (!session) return false;
      if (session.uploadAttemptId !== attemptId) {
        await transaction
          .update(uploadSessions)
          .set({
            storageMutationGeneration: sql`${uploadSessions.storageMutationGeneration} + 1`,
            storageMutationSettlesAt: sql`GREATEST(COALESCE(${uploadSessions.storageMutationSettlesAt}, clock_timestamp()), clock_timestamp() + ${MUTATION_SETTLEMENT_INTERVAL})`,
            ...(requiresObjectCleanup(session.state) &&
            session.cleanupCompletedAt
              ? { cleanupCompletedAt: null }
              : {}),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(uploadSessions.workspaceId, grant.workspaceId),
              eq(uploadSessions.id, grant.uploadSessionId),
            ),
          );
        return false;
      }
      const authorized =
        session.state === "pending" &&
        session.sessionNotExpired &&
        session.attemptNotExpired;
      await transaction
        .update(uploadSessions)
        .set({
          storageMutationGeneration: sql`${uploadSessions.storageMutationGeneration} + 1`,
          storageMutationSettlesAt: null,
          uploadAttemptId: null,
          uploadAttemptExpiresAt: null,
          ...(!authorized &&
          requiresObjectCleanup(session.state) &&
          session.cleanupCompletedAt
            ? { cleanupCompletedAt: null }
            : {}),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(uploadSessions.workspaceId, grant.workspaceId),
            eq(uploadSessions.id, grant.uploadSessionId),
            eq(uploadSessions.uploadAttemptId, attemptId),
          ),
        );
      return authorized;
    });
  };
}

async function recordAmbiguousMutation(
  database: Database,
  grant: ProxyUploadAuthorization,
  attemptId: string,
): Promise<void> {
  const [cleared] = await database
    .update(uploadSessions)
    .set({
      cleanupCompletedAt: sql`CASE WHEN ${uploadSessions.state} IN ('rejected', 'expired', 'cleanup_pending') THEN NULL ELSE ${uploadSessions.cleanupCompletedAt} END`,
      storageMutationGeneration: sql`${uploadSessions.storageMutationGeneration} + 1`,
      storageMutationSettlesAt: sql`GREATEST(COALESCE(${uploadSessions.storageMutationSettlesAt}, clock_timestamp()), clock_timestamp() + ${MUTATION_SETTLEMENT_INTERVAL})`,
      uploadAttemptId: null,
      uploadAttemptExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(uploadSessions.workspaceId, grant.workspaceId),
        eq(uploadSessions.id, grant.uploadSessionId),
        eq(uploadSessions.uploadAttemptId, attemptId),
      ),
    )
    .returning({ id: uploadSessions.id });
  if (!cleared) await rearmAmbiguousMutation(database, grant);
}

async function rearmAmbiguousMutation(
  database: Database,
  grant: ProxyUploadAuthorization,
): Promise<void> {
  await database
    .update(uploadSessions)
    .set({
      cleanupCompletedAt: sql`CASE WHEN ${uploadSessions.state} IN ('rejected', 'expired', 'cleanup_pending') THEN NULL ELSE ${uploadSessions.cleanupCompletedAt} END`,
      storageMutationGeneration: sql`${uploadSessions.storageMutationGeneration} + 1`,
      storageMutationSettlesAt: sql`GREATEST(COALESCE(${uploadSessions.storageMutationSettlesAt}, clock_timestamp()), clock_timestamp() + ${MUTATION_SETTLEMENT_INTERVAL})`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(uploadSessions.workspaceId, grant.workspaceId),
        eq(uploadSessions.id, grant.uploadSessionId),
      ),
    );
}
