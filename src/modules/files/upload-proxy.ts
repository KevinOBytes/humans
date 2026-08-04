import { and, eq, sql } from "drizzle-orm";

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

export function createUploadSessionProxyExecutor(input: {
  database: Database;
  deploymentMode: FileDeploymentMode;
}) {
  return async (
    grant: ProxyUploadAuthorization,
    upload: () => Promise<void>,
  ): Promise<boolean> =>
    input.database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({
          actorId: uploadSessions.actorId,
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

      // The row lock is intentionally held only across the bounded upstream
      // PUT. Cancellation takes the same lock, so exactly one ordering wins.
      await upload();
      return true;
    });
}
