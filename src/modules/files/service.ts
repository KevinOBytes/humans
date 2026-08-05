import { files } from "@/db/schema/files";
import { newId } from "@/db/id";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import type { RequestOperationLimiter } from "@/graphql/operation-limiter";
import type { ObjectStore } from "@/lib/storage/types";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  claimIdempotentResearchWrite,
  deriveResearchIdempotency,
  finalizeIdempotentResearchWrite,
  runIdempotentResearchWrite,
  runResearchTransaction,
  withResearchWriteTransaction,
} from "@/modules/audit/transactions";

import {
  createFilesRepository,
  type FileRow,
  type FileVariantRow,
  type UploadSessionRow,
} from "./repository";
import { noOpFileScanner, type FileScanner } from "./scanner";
import { ensureArchivedFileCleanupJob, ensureFileCleanupJob } from "./cleanup";
import {
  uploadSessionStates,
  type UploadPurpose,
  type UploadSessionState,
  type UploadValidationInput,
} from "./types";
import {
  assertFileTransition,
  UPLOAD_COMPLETION_CAPACITY,
  uploadCompletionCost,
  validateUploadRequest,
  verifyUploadStream,
} from "./validation";
import { uploadMaxBytesForDeployment, type FileDeploymentMode } from "./limits";

const GRANT_TTL_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const MAX_PENDING_ACTOR = 5;
const MAX_PENDING_WORKSPACE = 100;
const UPLOAD_SESSION_REFERENCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UPLOAD_COMPLETION_IDEMPOTENCY_TTL_MS = 15 * 60_000;

type UploadCompletionResponseReference = {
  fileId: string;
  uploadSessionId: string;
};

function parseUploadCompletionReference(
  value: unknown,
): UploadCompletionResponseReference {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  ) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      publicErrorMessage("PRECONDITION_FAILED"),
    );
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.fileId !== "string" ||
    !UPLOAD_SESSION_REFERENCE_UUID.test(candidate.fileId) ||
    typeof candidate.uploadSessionId !== "string" ||
    !UPLOAD_SESSION_REFERENCE_UUID.test(candidate.uploadSessionId)
  ) {
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      publicErrorMessage("PRECONDITION_FAILED"),
    );
  }
  return {
    fileId: candidate.fileId,
    uploadSessionId: candidate.uploadSessionId,
  };
}

export type FileServiceContext = ResearchServiceContext & {
  operationLimiter: RequestOperationLimiter;
};

export type FileServiceRuntime = {
  deploymentMode: FileDeploymentMode;
  objectStore?: ObjectStore;
  scanner?: FileScanner;
  storageBucket: string;
  storageProvider: "minio" | "r2" | "s3";
  encryptionKey?: string;
};

function requirePermission(
  context: FileServiceContext,
  permission: "file:create" | "file:delete" | "file:read",
): void {
  if (!context.permissions.has(permission)) {
    throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
  }
}

function requireSessionActor(
  context: FileServiceContext,
): asserts context is FileServiceContext & {
  actor: Extract<FileServiceContext["actor"], { type: "user" }>;
} {
  if (context.actor.type !== "user") {
    throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
  }
}

function notFound(): never {
  throw createGraphQLError("NOT_FOUND", publicErrorMessage("NOT_FOUND"));
}

function providerUnavailable(): never {
  throw createGraphQLError(
    "PROVIDER_UNAVAILABLE",
    publicErrorMessage("PROVIDER_UNAVAILABLE"),
  );
}

function uploadRejected(): never {
  throw createGraphQLError(
    "UPLOAD_REJECTED",
    publicErrorMessage("UPLOAD_REJECTED"),
  );
}

function encodeCursor(row: FileRow): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: row.createdAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  value?: string | null,
): { createdAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      v?: unknown;
      t?: unknown;
      i?: unknown;
    };
    const createdAt = new Date(typeof parsed.t === "string" ? parsed.t : "");
    if (
      parsed.v !== 1 ||
      typeof parsed.i !== "string" ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid");
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The file cursor is invalid.",
    );
  }
}

function encodeUploadSessionCursor(row: UploadSessionRow): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: row.createdAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeUploadSessionCursor(
  value?: string | null,
): { createdAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { v?: unknown; t?: unknown; i?: unknown };
    const createdAt = new Date(typeof parsed.t === "string" ? parsed.t : "");
    if (
      parsed.v !== 1 ||
      typeof parsed.i !== "string" ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid");
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The upload-session cursor is invalid.",
    );
  }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("checksum")) return "CHECKSUM_MISMATCH";
  if (message.includes("size") || message.includes("bytes"))
    return "SIZE_MISMATCH";
  if (message.includes("utf")) return "INVALID_ENCODING";
  if (message.includes("type") || message.includes("content"))
    return "TYPE_MISMATCH";
  if (
    message.includes("csv") ||
    message.includes("json") ||
    message.includes("import")
  ) {
    return "INVALID_IMPORT_CONTENT";
  }
  return "CONTENT_REJECTED";
}

export function createFilesService(
  context: FileServiceContext,
  runtime: FileServiceRuntime,
) {
  if (runtime.objectStore && !runtime.encryptionKey) {
    throw new TypeError(
      "DATA_ENCRYPTION_KEY is required when object storage is enabled",
    );
  }
  const encryptionKey = runtime.encryptionKey;
  const repository = createFilesRepository(context.database);
  const audit = createAuditService(context);
  const scanner = runtime.scanner ?? noOpFileScanner;
  const visibility = resourceVisibilitySql(context, {
    id: files.id,
    resourceKind: "file",
    sensitivity: files.sensitivity,
  });

  async function rejectSession(
    session: UploadSessionRow,
    code: string,
  ): Promise<void> {
    await withResearchWriteTransaction(context, async (database) => {
      const txRepository = createFilesRepository(database);
      const updated = await txRepository.setSessionState({
        id: session.id,
        workspaceId: context.workspaceId,
        from: ["verifying", "pending"],
        state: "rejected",
        failureCode: code.slice(0, 64),
        updatedAt: new Date(),
        updatedBy: context.actor.id,
      });
      if (updated) {
        await audit.write(database, {
          action: "file.upload_rejected",
          changedFields: ["state", "failureCode"],
          metadata: { failureCode: code.slice(0, 64) },
          resourceId: session.id,
          resourceKind: "upload_session",
          sensitivity: session.sensitivity,
        });
        if (encryptionKey) {
          await ensureFileCleanupJob({
            database,
            encryptionKey,
            workspaceId: context.workspaceId,
            uploadSessionId: session.id,
            expiresAt: session.expiresAt,
            createdBy: context.actor.type === "user" ? context.actor.id : null,
          });
        }
      }
    });
    try {
      await runtime.objectStore?.delete({
        workspaceId: context.workspaceId,
        key: session.objectKey,
      });
    } catch {
      // Durable rejected state is the source of truth for exact-key cleanup.
    }
  }

  return {
    async createUploadSession(input: UploadValidationInput) {
      requireSessionActor(context);
      requirePermission(context, "file:create");
      const store = runtime.objectStore;
      if (!store) return providerUnavailable();
      let validated: ReturnType<typeof validateUploadRequest>;
      try {
        validated = validateUploadRequest(input, {
          maxBytes: uploadMaxBytesForDeployment(
            input.purpose,
            runtime.deploymentMode,
          ),
        });
      } catch {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The upload request is invalid.",
        );
      }
      if (!(await repository.isStorageEnabled(context.workspaceId))) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Storage is disabled for this workspace.",
        );
      }
      await context.operationLimiter.consume({
        cost: 1,
        operationClass: "file.upload.create.actor",
        policy: {
          capacity: 20,
          refillAmount: 20,
          refillIntervalMs: 15 * 60_000,
          ttlMs: 15 * 60_000,
        },
      });
      await context.operationLimiter.consume({
        cost: 1,
        operationClass: "file.upload.create.workspace",
        scope: "workspace",
        policy: {
          capacity: 100,
          refillAmount: 100,
          refillIntervalMs: 60 * 60_000,
          ttlMs: 60 * 60_000,
        },
      });
      const persistSession = async (
        writeContext: ResearchServiceContext,
        database: ResearchServiceContext["database"],
      ): Promise<UploadSessionRow> => {
        const now = new Date();
        const id = newId();
        const expiresAt = new Date(now.getTime() + GRANT_TTL_MS);
        const objectKey = `uploads/${id}/${newId()}`;
        const txRepository = createFilesRepository(database);
        await txRepository.serializeUploadCapacity(writeContext.workspaceId);
        const [actorPending, workspacePending] = await Promise.all([
          txRepository.countPending({
            actorId: writeContext.actor.id,
            workspaceId: writeContext.workspaceId,
            now,
          }),
          txRepository.countPending({
            workspaceId: writeContext.workspaceId,
            now,
          }),
        ]);
        if (
          actorPending >= MAX_PENDING_ACTOR ||
          workspacePending >= MAX_PENDING_WORKSPACE
        ) {
          throw createGraphQLError(
            "RATE_LIMITED",
            publicErrorMessage("RATE_LIMITED"),
          );
        }
        const created = await txRepository.createSession({
          id,
          workspaceId: writeContext.workspaceId,
          actorId: writeContext.actor.id,
          intendedPurpose: validated.purpose,
          originalName: validated.originalName,
          sensitivity: validated.sensitivity,
          maxBytes: validated.byteSize,
          expectedChecksum: validated.checksumSha256,
          expectedMediaType: validated.claimedMediaType,
          objectKey,
          state: "pending",
          expiresAt,
          createdAt: now,
          createdBy: writeContext.actor.id,
          updatedAt: now,
          updatedBy: writeContext.actor.id,
        });
        if (encryptionKey) {
          await ensureFileCleanupJob({
            database,
            encryptionKey,
            workspaceId: writeContext.workspaceId,
            uploadSessionId: created.id,
            expiresAt: created.expiresAt,
            createdBy: writeContext.actor.id,
          });
        }
        await createAuditService(writeContext).write(database, {
          action: "file.upload_session_created",
          changedFields: ["state", "intendedPurpose", "maxBytes"],
          metadata: {
            byteSize: validated.byteSize,
            purpose: validated.purpose,
          },
          resourceId: created.id,
          resourceKind: "upload_session",
          sensitivity: validated.sensitivity,
        });
        return created;
      };
      let session: UploadSessionRow;
      if (input.idempotencyKey != null) {
        if (!encryptionKey) return providerUnavailable();
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + GRANT_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "file.upload.session.create",
          requestMaterial: {
            byteSize: validated.byteSize,
            claimedMediaType: validated.claimedMediaType,
            checksumSha256: validated.checksumSha256,
            originalName: validated.originalName,
            purpose: validated.purpose,
            sensitivity: validated.sensitivity,
          },
          secret: encryptionKey,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["file:create"],
          async (scopedContext) => {
            const created = await persistSession(
              scopedContext,
              scopedContext.database,
            );
            return { uploadSessionId: created.id };
          },
        );
        if (
          typeof result.responseReference.uploadSessionId !== "string" ||
          !UPLOAD_SESSION_REFERENCE_UUID.test(
            result.responseReference.uploadSessionId,
          )
        ) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            publicErrorMessage("PRECONDITION_FAILED"),
          );
        }
        const replayedSession = await repository.getSession({
          id: result.responseReference.uploadSessionId,
          workspaceId: context.workspaceId,
        });
        if (!replayedSession || replayedSession.actorId !== context.actor.id)
          return notFound();
        session = replayedSession;
      } else {
        session = await withResearchWriteTransaction(
          context,
          async (database) => persistSession(context, database),
        );
      }
      try {
        const grant = await store.createUpload({
          actorId: session.actorId,
          workspaceId: context.workspaceId,
          uploadSessionId: session.id,
          sessionExpiresAt: session.expiresAt,
          key: session.objectKey,
          bytes: session.maxBytes,
          contentType: session.expectedMediaType!,
          checksumSha256: session.expectedChecksum!,
        });
        return { session, grant, issues: [] as const };
      } catch {
        return providerUnavailable();
      }
    },

    async completeUpload(
      uploadSessionId: string,
      idempotencyKey?: string | null,
    ) {
      requireSessionActor(context);
      requirePermission(context, "file:create");
      const store = runtime.objectStore;
      if (!store) return providerUnavailable();
      const initial = await repository.getSession({
        id: uploadSessionId,
        workspaceId: context.workspaceId,
      });
      if (!initial || initial.actorId !== context.actor.id) return notFound();
      let idempotency: ReturnType<typeof deriveResearchIdempotency> | undefined;
      let idempotencyClaim:
        Awaited<ReturnType<typeof claimIdempotentResearchWrite>> | undefined;
      if (idempotencyKey != null) {
        if (!encryptionKey) return providerUnavailable();
        idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(
            Date.now() + UPLOAD_COMPLETION_IDEMPOTENCY_TTL_MS,
          ),
          idempotencyKey,
          operation: "file.upload.complete",
          requestMaterial: { uploadSessionId },
          secret: encryptionKey,
        });
        idempotencyClaim = await claimIdempotentResearchWrite(
          context,
          idempotency,
          ["file:create"],
        );
        if (idempotencyClaim.state === "completed") {
          const reference = parseUploadCompletionReference(
            idempotencyClaim.responseReference,
          );
          if (
            reference.uploadSessionId !== uploadSessionId ||
            initial.state !== "completed" ||
            initial.fileId !== reference.fileId
          ) {
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              publicErrorMessage("PRECONDITION_FAILED"),
            );
          }
          const file = await repository.getFile({
            id: reference.fileId,
            workspaceId: context.workspaceId,
          });
          if (!file) {
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              publicErrorMessage("PRECONDITION_FAILED"),
            );
          }
          return { session: initial, file, issues: [] as const };
        }
      }
      const finalize = async <
        T extends {
          file: FileRow;
          session: UploadSessionRow;
          issues: readonly [];
        },
      >(
        result: T,
      ): Promise<T> => {
        if (idempotency && idempotencyClaim) {
          await finalizeIdempotentResearchWrite(
            context,
            idempotency,
            idempotencyClaim.claimId,
            {
              fileId: result.file.id,
              uploadSessionId: result.session.id,
            },
            ["file:create"],
          );
        }
        return result;
      };
      const waitForConcurrentCompletion = async (): Promise<{
        file: FileRow;
        session: UploadSessionRow;
      } | null> => {
        if (!idempotencyClaim || idempotencyClaim.state !== "pending") {
          return null;
        }
        const startedAt = Date.now();
        const deadline = startedAt + VERIFY_TIMEOUT_MS + 5_000;
        while (Date.now() < deadline) {
          const current = await repository.getSession({
            id: uploadSessionId,
            workspaceId: context.workspaceId,
          });
          if (!current || current.actorId !== context.actor.id) return null;
          if (current.state === "completed" && current.fileId) {
            const file = await repository.getFile({
              id: current.fileId,
              workspaceId: context.workspaceId,
            });
            if (!file) return null;
            return { file, session: current };
          }
          if (current.state === "pending" && Date.now() - startedAt >= 100) {
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      };
      const concurrentCompletion = await waitForConcurrentCompletion();
      if (concurrentCompletion) {
        return finalize({ ...concurrentCompletion, issues: [] as const });
      }
      await context.operationLimiter.consume({
        cost: uploadCompletionCost(initial.maxBytes),
        operationClass: "file.upload.complete.actor",
        policy: {
          capacity: UPLOAD_COMPLETION_CAPACITY,
          refillAmount: UPLOAD_COMPLETION_CAPACITY,
          refillIntervalMs: 15 * 60_000,
          ttlMs: 15 * 60_000,
        },
      });
      const claim = await withResearchWriteTransaction(
        context,
        async (database) => {
          const txRepository = createFilesRepository(database);
          const session = await txRepository.lockSession({
            id: uploadSessionId,
            workspaceId: context.workspaceId,
          });
          if (!session || session.actorId !== context.actor.id)
            return notFound();
          if (session.state === "completed" && session.fileId) {
            const file = await txRepository.getFile({
              id: session.fileId,
              workspaceId: context.workspaceId,
            });
            if (!file) throw new Error("Completed upload file is missing");
            return { mode: "replay" as const, session, file };
          }
          if (
            session.state === "verifying" &&
            idempotencyClaim?.state === "pending"
          ) {
            return { mode: "wait" as const };
          }
          if (session.state !== "pending") {
            throw createGraphQLError(
              "CONFLICT",
              "The upload session is not pending.",
            );
          }
          const now = new Date();
          if (session.expiresAt <= now) {
            await txRepository.setSessionState({
              id: session.id,
              workspaceId: context.workspaceId,
              from: ["pending"],
              state: "expired",
              failureCode: "SESSION_EXPIRED",
              updatedAt: now,
              updatedBy: context.actor.id,
            });
            return { mode: "expired" as const };
          }
          const verifying = await txRepository.setSessionState({
            id: session.id,
            workspaceId: context.workspaceId,
            from: ["pending"],
            state: "verifying",
            updatedAt: now,
            updatedBy: context.actor.id,
          });
          if (!verifying) {
            throw createGraphQLError(
              "CONFLICT",
              publicErrorMessage("CONFLICT"),
            );
          }
          return { mode: "verify" as const, session: verifying };
        },
      );
      if (claim.mode === "expired") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The upload session has expired.",
        );
      }
      if (claim.mode === "wait") {
        const settled = await waitForConcurrentCompletion();
        if (settled) return finalize({ ...settled, issues: [] as const });
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      }
      if (claim.mode === "replay") {
        return finalize({
          session: claim.session,
          file: claim.file,
          issues: [] as const,
        });
      }
      const session = claim.session;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
      let verified:
        | { byteSize: number; checksum: string; detectedType: string }
        | undefined;
      try {
        const metadata = await store.getMetadata({
          workspaceId: context.workspaceId,
          key: session.objectKey,
        });
        if (!metadata) {
          await rejectSession(session, "OBJECT_MISSING");
          return uploadRejected();
        }
        const object = await store.openRead(
          { workspaceId: context.workspaceId, key: session.objectKey },
          { maxBytes: session.maxBytes, signal: controller.signal },
        );
        if (!object) {
          await rejectSession(session, "OBJECT_MISSING");
          return uploadRejected();
        }
        verified = await verifyUploadStream({
          stream: object.body,
          originalName: session.originalName,
          claimedMediaType: session.expectedMediaType!,
          purpose: session.intendedPurpose as UploadPurpose,
          expectedBytes: session.maxBytes,
          expectedChecksumSha256: session.expectedChecksum!,
        });
      } catch (error) {
        if (error instanceof TypeError) {
          await rejectSession(session, failureCode(error));
          return uploadRejected();
        }
        await withResearchWriteTransaction(context, async (database) => {
          await createFilesRepository(database).setSessionState({
            id: session.id,
            workspaceId: context.workspaceId,
            from: ["verifying"],
            state: "pending",
            failureCode: "PROVIDER_RETRYABLE",
            updatedAt: new Date(),
            updatedBy: context.actor.id,
          });
        });
        return providerUnavailable();
      } finally {
        clearTimeout(timeout);
      }
      if (!verified) return uploadRejected();
      const now = new Date();
      const created = await withResearchWriteTransaction(
        context,
        async (database) => {
          const txRepository = createFilesRepository(database);
          const locked = await txRepository.lockSession({
            id: session.id,
            workspaceId: context.workspaceId,
          });
          if (!locked) return notFound();
          if (locked.state === "completed" && locked.fileId) {
            const existing = await txRepository.getFile({
              id: locked.fileId,
              workspaceId: context.workspaceId,
            });
            if (!existing) throw new Error("Completed upload file is missing");
            return { session: locked, file: existing };
          }
          if (locked.state !== "verifying") {
            throw createGraphQLError(
              "CONFLICT",
              publicErrorMessage("CONFLICT"),
            );
          }
          const file = await txRepository.createFile({
            id: newId(),
            workspaceId: context.workspaceId,
            storageProvider: runtime.storageProvider,
            storageBucket: runtime.storageBucket,
            storageKey: locked.objectKey,
            originalName: locked.originalName,
            mediaType: locked.expectedMediaType,
            detectedType: verified!.detectedType,
            byteSize: verified!.byteSize,
            checksum: verified!.checksum,
            quarantineState: "quarantined",
            scanState: "pending",
            ocrState: "not_requested",
            extractionState: "not_requested",
            sensitivity: locked.sensitivity,
            uploadedBy: context.actor.id,
            createdAt: now,
            createdBy: context.actor.id,
            updatedAt: now,
            updatedBy: context.actor.id,
          });
          const completed = await txRepository.setSessionState({
            id: locked.id,
            workspaceId: context.workspaceId,
            from: ["verifying"],
            state: "completed",
            fileId: file.id,
            failureCode: null,
            completedAt: now,
            updatedAt: now,
            updatedBy: context.actor.id,
          });
          if (!completed) throw new Error("Upload completion state was lost");
          await txRepository.addStorageUsage({
            workspaceId: context.workspaceId,
            byteSize: file.byteSize,
            now,
            actorId: context.actor.id,
          });
          await audit.write(database, {
            action: "file.upload_completed",
            changedFields: ["quarantineState", "scanState", "byteSize"],
            metadata: { byteSize: file.byteSize },
            resourceId: file.id,
            resourceKind: "file",
            sensitivity: file.sensitivity,
          });
          return { session: completed, file };
        },
      );
      let scan;
      try {
        scan = await scanner.scan({
          byteSize: created.file.byteSize,
          detectedType: created.file.detectedType!,
          open: () =>
            store.openRead(
              {
                workspaceId: context.workspaceId,
                key: created.file.storageKey,
              },
              { maxBytes: created.file.byteSize },
            ),
        });
      } catch {
        scan = { state: "error" as const, code: "SCANNER_UNAVAILABLE" };
      }
      const quarantineState =
        scan.state === "clean" || scan.state === "not_required"
          ? "available"
          : scan.state === "infected"
            ? "rejected"
            : "quarantined";
      if (quarantineState !== "quarantined") {
        assertFileTransition(
          "quarantined",
          quarantineState,
          scan.state === "infected" ? "infected" : scan.state,
        );
      }
      const scanned = await withResearchWriteTransaction(
        context,
        async (database) => {
          const row = await createFilesRepository(database).updateScan({
            id: created.file.id,
            workspaceId: context.workspaceId,
            quarantineState,
            scanState: scan.state,
            updatedAt: new Date(),
            updatedBy: context.actor.id,
          });
          if (!row) throw new Error("File scan transition was lost");
          await audit.write(database, {
            action: "file.scan_recorded",
            changedFields: ["quarantineState", "scanState"],
            metadata: { scanState: scan.state },
            resourceId: row.id,
            resourceKind: "file",
            sensitivity: row.sensitivity,
          });
          if (scan.state === "infected" && encryptionKey) {
            const session = await createFilesRepository(database).getSession({
              id: created.session.id,
              workspaceId: context.workspaceId,
            });
            if (!session) throw new Error("Upload session is missing");
            await ensureFileCleanupJob({
              database,
              encryptionKey,
              workspaceId: context.workspaceId,
              uploadSessionId: session.id,
              expiresAt: session.expiresAt,
              createdBy: context.actor.id,
            });
          }
          return row;
        },
      );
      if (scan.state === "infected") {
        try {
          await store.delete({
            workspaceId: context.workspaceId,
            key: created.file.storageKey,
          });
        } catch {
          // Rejected state remains fail closed if deletion must be retried.
        }
      }
      return finalize({
        session: created.session,
        file: scanned,
        issues: [] as const,
      });
    },

    async listUploadSessions(input: {
      first?: number | null;
      after?: string | null;
      states?: readonly UploadSessionState[] | null;
    }) {
      requireSessionActor(context);
      requirePermission(context, "file:create");
      const first = input.first ?? 20;
      if (!Number.isInteger(first) || first < 1 || first > 100) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The page size is invalid.",
        );
      }
      const states = input.states?.length
        ? [...new Set(input.states)]
        : ["pending" as const];
      if (
        states.length > uploadSessionStates.length ||
        states.some((state) => !uploadSessionStates.includes(state))
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The upload-session state filter is invalid.",
        );
      }
      const rows = await repository.listUploadSessions({
        actorId: context.actor.id,
        workspaceId: context.workspaceId,
        limit: first + 1,
        states,
        cursor: decodeUploadSessionCursor(input.after),
      });
      const nodes = rows.slice(0, first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: nodes.length
            ? encodeUploadSessionCursor(nodes.at(-1)!)
            : null,
        },
      };
    },

    async regrantUploadSession(uploadSessionId: string) {
      requireSessionActor(context);
      requirePermission(context, "file:create");
      const store = runtime.objectStore;
      if (!store) return providerUnavailable();
      const result = await runResearchTransaction(
        context,
        { requiredPermissions: ["file:create"] },
        async (transactionContext) => {
          const txRepository = createFilesRepository(
            transactionContext.database,
          );
          const session = await txRepository.lockSession({
            id: uploadSessionId,
            workspaceId: context.workspaceId,
            actorId: context.actor.id,
          });
          if (!session) return { state: "not_found" as const };
          if (session.state !== "pending") {
            return { state: "conflict" as const };
          }
          const now = new Date();
          if (session.expiresAt <= now) {
            const expired = await txRepository.setSessionState({
              id: session.id,
              workspaceId: context.workspaceId,
              from: ["pending"],
              state: "expired",
              failureCode: "SESSION_EXPIRED",
              completedAt: null,
              updatedAt: now,
              updatedBy: context.actor.id,
            });
            if (expired && encryptionKey) {
              await ensureFileCleanupJob({
                database: transactionContext.database,
                encryptionKey,
                workspaceId: context.workspaceId,
                uploadSessionId: session.id,
                expiresAt: session.expiresAt,
                createdBy: context.actor.id,
                scheduledAt: now,
              });
            }
            return { state: "conflict" as const };
          }
          let currentMaxBytes: number;
          try {
            currentMaxBytes = uploadMaxBytesForDeployment(
              session.intendedPurpose as UploadPurpose,
              runtime.deploymentMode,
            );
          } catch {
            return { state: "conflict" as const };
          }
          if (session.maxBytes > currentMaxBytes) {
            return { state: "conflict" as const };
          }
          try {
            const grant = await store.createUpload({
              actorId: session.actorId,
              workspaceId: context.workspaceId,
              uploadSessionId: session.id,
              sessionExpiresAt: session.expiresAt,
              key: session.objectKey,
              bytes: session.maxBytes,
              contentType: session.expectedMediaType!,
              checksumSha256: session.expectedChecksum!,
            });
            return { state: "pending" as const, session, grant };
          } catch {
            return { state: "provider_error" as const };
          }
        },
      );
      if (result.state === "not_found") return notFound();
      if (result.state === "conflict") {
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      }
      if (result.state === "provider_error") return providerUnavailable();
      return {
        session: result.session,
        grant: result.grant,
        issues: [] as const,
      };
    },

    async cancelUploadSession(uploadSessionId: string) {
      requireSessionActor(context);
      requirePermission(context, "file:create");
      if (!encryptionKey) return providerUnavailable();
      const now = new Date();
      const result = await runResearchTransaction(
        context,
        { requiredPermissions: ["file:create"] },
        async (transactionContext) => {
          const txRepository = createFilesRepository(
            transactionContext.database,
          );
          const session = await txRepository.lockSession({
            id: uploadSessionId,
            workspaceId: context.workspaceId,
            actorId: context.actor.id,
          });
          if (!session) return { state: "not_found" as const };
          if (session.state !== "pending") {
            return { state: "conflict" as const };
          }
          const cancelled = await txRepository.setSessionState({
            id: session.id,
            workspaceId: context.workspaceId,
            from: ["pending"],
            state: "cleanup_pending",
            failureCode: "USER_CANCELLED",
            completedAt: null,
            cleanupCompletedAt: null,
            updatedAt: now,
            updatedBy: context.actor.id,
          });
          if (!cancelled) return { state: "conflict" as const };
          await ensureFileCleanupJob({
            database: transactionContext.database,
            encryptionKey,
            workspaceId: context.workspaceId,
            uploadSessionId: session.id,
            expiresAt: session.expiresAt,
            createdBy: context.actor.id,
            scheduledAt: now,
          });
          await audit.write(transactionContext.database, {
            action: "file.upload_cancelled",
            changedFields: ["state"],
            metadata: { state: "cleanup_pending" },
            resourceId: session.id,
            resourceKind: "upload_session",
            sensitivity: session.sensitivity,
          });
          return { state: "cancelled" as const, session: cancelled };
        },
      );
      if (result.state === "not_found") return notFound();
      if (result.state === "conflict") {
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      }
      try {
        await runtime.objectStore?.delete({
          workspaceId: context.workspaceId,
          key: result.session.objectKey,
        });
      } catch {
        // The immediate durable cleanup job remains authoritative.
      }
      return { session: result.session, issues: [] as const };
    },

    async get(id: string): Promise<FileRow | null> {
      requirePermission(context, "file:read");
      return repository.getFile({
        id,
        workspaceId: context.workspaceId,
        visibility,
      });
    },

    async archiveFile(fileId: string, expectedVersion: number) {
      requirePermission(context, "file:delete");
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The file version is invalid.",
        );
      }
      if (!encryptionKey) return providerUnavailable();
      const now = new Date();
      const archived = await runResearchTransaction(
        context,
        { requiredPermissions: ["file:delete"] },
        async (transactionContext) => {
          const txRepository = createFilesRepository(
            transactionContext.database,
          );
          const locked = await txRepository.lockFileForArchive({
            id: fileId,
            workspaceId: context.workspaceId,
            visibility,
          });
          if (!locked) return { state: "not_found" as const };
          if (locked.version !== expectedVersion) {
            return { state: "conflict" as const };
          }
          if (
            !(await canAccessResource(
              transactionContext.database,
              transactionContext,
              {
                id: locked.id,
                lockGrants: true,
                resourceKind: "file",
                sensitivity: locked.sensitivity,
              },
            ))
          ) {
            return { state: "not_found" as const };
          }
          const file = await txRepository.archiveFile({
            id: fileId,
            workspaceId: context.workspaceId,
            expectedVersion,
            deletedAt: now,
            deletedBy: context.actor.id,
          });
          if (!file) return { state: "conflict" as const };
          await ensureArchivedFileCleanupJob({
            database: transactionContext.database,
            encryptionKey,
            workspaceId: context.workspaceId,
            fileId,
            createdBy: context.actor.type === "user" ? context.actor.id : null,
          });
          await audit.write(transactionContext.database, {
            action: "file.archived",
            changedFields: ["deletedAt"],
            resourceId: fileId,
            resourceKind: "file",
            sensitivity: file.sensitivity,
          });
          return { state: "archived" as const, file };
        },
      );
      if (archived.state === "not_found") return notFound();
      if (archived.state === "conflict") {
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      }
      return { file: archived.file, issues: [] as const };
    },

    async listVariants(file: FileRow): Promise<readonly FileVariantRow[]> {
      if (file.workspaceId !== context.workspaceId) return notFound();
      if (file.deletedAt) {
        requirePermission(context, "file:delete");
      } else {
        requirePermission(context, "file:read");
        const visibleFile = await repository.getFile({
          id: file.id,
          workspaceId: context.workspaceId,
          visibility,
        });
        if (!visibleFile) return notFound();
      }
      return repository.listFileVariants({
        fileId: file.id,
        workspaceId: context.workspaceId,
      });
    },

    async getByIds(
      ids: readonly string[],
    ): Promise<readonly (FileRow | null)[]> {
      requirePermission(context, "file:read");
      const rows = await repository.getFiles({
        ids,
        workspaceId: context.workspaceId,
        visibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },

    async list(input: {
      first?: number | null;
      after?: string | null;
      availability?: string | null;
    }) {
      requirePermission(context, "file:read");
      const first = input.first ?? 25;
      if (!Number.isInteger(first) || first < 1 || first > 100) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The page size is invalid.",
        );
      }
      const availability = input.availability?.toLowerCase() ?? null;
      if (
        availability &&
        !["quarantined", "available", "rejected"].includes(availability)
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The file filter is invalid.",
        );
      }
      const rows = await repository.listFiles({
        workspaceId: context.workspaceId,
        limit: first + 1,
        cursor: decodeCursor(input.after),
        availability,
        visibility,
      });
      const nodes = rows.slice(0, first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: nodes.length ? encodeCursor(nodes.at(-1)!) : null,
        },
      };
    },

    async createDownload(fileId: string) {
      requirePermission(context, "file:read");
      const store = runtime.objectStore;
      if (!store) return providerUnavailable();
      await context.operationLimiter.consume({
        cost: 1,
        operationClass: "file.download.actor",
        policy: {
          capacity: 60,
          refillAmount: 60,
          refillIntervalMs: 60_000,
          ttlMs: 60_000,
        },
      });
      const file = await repository.getFile({
        id: fileId,
        workspaceId: context.workspaceId,
        visibility,
      });
      if (!file) return notFound();
      if (
        !(await canAccessResource(context.database, context, {
          id: file.id,
          resourceKind: "file",
          sensitivity: file.sensitivity,
        }))
      ) {
        return notFound();
      }
      if (
        file.quarantineState !== "available" ||
        !["clean", "not_required"].includes(file.scanState)
      ) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The file is not available for download.",
        );
      }
      let grant;
      try {
        grant = await store.createDownload({
          workspaceId: context.workspaceId,
          key: file.storageKey,
          fileName: file.originalName,
        });
      } catch {
        return providerUnavailable();
      }
      await withResearchWriteTransaction(context, (database) =>
        audit.write(database, {
          action: "file.download_grant_created",
          changedFields: [],
          resourceId: file.id,
          resourceKind: "file",
          sensitivity: file.sensitivity,
        }),
      );
      return { file, grant, issues: [] as const };
    },

    async purposeForFile(fileId: string): Promise<string | null> {
      return repository.purposeForFile({
        fileId,
        workspaceId: context.workspaceId,
      });
    },

    maxBytesForPurpose(purpose: UploadPurpose): number {
      return uploadMaxBytesForDeployment(purpose, runtime.deploymentMode);
    },
  };
}

export type FilesService = ReturnType<typeof createFilesService>;
