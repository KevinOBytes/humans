import { and, eq, inArray, isNull } from "drizzle-orm";

import { extractionRuns, files } from "@/db/schema/files";
import { createGraphQLError } from "@/graphql/errors";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { createJobsService } from "@/modules/jobs/service";
import { safeJobFailureCode } from "@/modules/jobs/types";
import { newId } from "@/db/id";
import type { ObjectStore } from "@/lib/storage/types";

const EXTRACTOR = /^[a-z][a-z0-9_.-]{1,63}$/u;

export function createExtractionService(
  context: ResearchServiceContext,
  input: { encryptionKey: string; objectStore: ObjectStore },
) {
  async function requireFile(fileId: string) {
    const [file] = await context.database
      .select()
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.workspaceId, context.workspaceId),
          isNull(files.deletedAt),
          resourceVisibilitySql(context, {
            resourceKind: "file",
            id: files.id,
            sensitivity: files.sensitivity,
          }),
        ),
      )
      .limit(1);
    if (!file)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested file was not found.",
      );
    return file;
  }
  return {
    async list(fileId: string) {
      await requireFile(fileId);
      return context.database
        .select()
        .from(extractionRuns)
        .where(
          and(
            eq(extractionRuns.workspaceId, context.workspaceId),
            eq(extractionRuns.fileId, fileId),
          ),
        );
    },
    async request(inputValue: {
      fileId: string;
      extractor?: string;
      configuration?: unknown;
    }) {
      if (!context.permissions.has("file:update")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "File extraction is not permitted.",
        );
      }
      const file = await requireFile(inputValue.fileId);
      if (file.quarantineState !== "available") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The file is not available for extraction.",
        );
      }
      const extractor = (inputValue.extractor ?? "text").trim().toLowerCase();
      if (!EXTRACTOR.test(extractor)) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The extractor name is invalid.",
        );
      }
      const runId = newId();
      const jobIdempotency = `extraction:${runId}`;
      const createdBy = context.actor.type === "user" ? context.actor.id : null;
      const principalId =
        context.actor.type === "apiKey" ? context.actor.principalId : null;
      return context.database.transaction(async (transaction) => {
        await transaction.insert(extractionRuns).values({
          id: runId,
          workspaceId: context.workspaceId,
          fileId: file.id,
          extractor,
          extractorVersion: "1",
          configuration:
            inputValue.configuration &&
            typeof inputValue.configuration === "object" &&
            !Array.isArray(inputValue.configuration)
              ? inputValue.configuration
              : {},
          state: "pending",
          createdBy: createdBy ?? context.actor.id,
        });
        const job = await createJobsService({
          database: transaction,
          encryptionKey: input.encryptionKey,
        }).enqueue({
          createdBy,
          principalId,
          idempotencyKey: jobIdempotency,
          payload: {
            kind: "extraction_execute",
            extractionRunId: runId,
            fileId: file.id,
          },
          workspaceId: context.workspaceId,
        });
        return { runId, jobId: job.id };
      });
    },
    async cancel(runId: string) {
      if (!context.permissions.has("file:update")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "File extraction is not permitted.",
        );
      }
      const [run] = await context.database
        .select()
        .from(extractionRuns)
        .where(
          and(
            eq(extractionRuns.workspaceId, context.workspaceId),
            eq(extractionRuns.id, runId),
          ),
        )
        .limit(1);
      if (!run) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested extraction run was not found.",
        );
      }
      const file = await requireFile(run.fileId);
      const cancelled = await context.database.transaction(
        async (transaction) => {
          const [updated] = await transaction
            .update(extractionRuns)
            .set({
              state: "cancelled",
              errorSummary: {
                code: safeJobFailureCode("extraction_cancelled"),
              },
              completedAt: new Date(),
            })
            .where(
              and(
                eq(extractionRuns.workspaceId, context.workspaceId),
                eq(extractionRuns.id, run.id),
                inArray(extractionRuns.state, ["pending", "processing"]),
              ),
            )
            .returning();
          if (!updated) return null;
          await transaction
            .update(files)
            .set({
              extractionState: "cancelled",
              version: file.version + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(files.workspaceId, context.workspaceId),
                eq(files.id, run.fileId),
              ),
            );
          return updated;
        },
      );
      if (!cancelled) {
        throw createGraphQLError(
          "CONFLICT",
          "The extraction run is no longer cancellable.",
        );
      }
      return cancelled;
    },
    async retry(runId: string) {
      if (!context.permissions.has("file:update")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "File extraction is not permitted.",
        );
      }
      const [run] = await context.database
        .select()
        .from(extractionRuns)
        .where(
          and(
            eq(extractionRuns.workspaceId, context.workspaceId),
            eq(extractionRuns.id, runId),
          ),
        )
        .limit(1);
      if (!run) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested extraction run was not found.",
        );
      }
      const file = await requireFile(run.fileId);
      if (file.quarantineState !== "available") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The file is not available for extraction.",
        );
      }
      if (run.state !== "error" && run.state !== "cancelled") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Only failed or cancelled extraction runs can be retried.",
        );
      }
      const createdBy = context.actor.type === "user" ? context.actor.id : null;
      const principalId =
        context.actor.type === "apiKey" ? context.actor.principalId : null;
      return context.database.transaction(async (transaction) => {
        const [reset] = await transaction
          .update(extractionRuns)
          .set({
            state: "pending",
            startedAt: null,
            completedAt: null,
            errorSummary: null,
          })
          .where(
            and(
              eq(extractionRuns.workspaceId, context.workspaceId),
              eq(extractionRuns.id, run.id),
              inArray(extractionRuns.state, ["error", "cancelled"]),
            ),
          )
          .returning({ id: extractionRuns.id });
        if (!reset) {
          throw createGraphQLError(
            "CONFLICT",
            "The extraction run changed before it could be retried.",
          );
        }
        await transaction
          .update(files)
          .set({
            extractionState: "pending",
            updatedAt: new Date(),
            version: file.version + 1,
          })
          .where(
            and(
              eq(files.workspaceId, context.workspaceId),
              eq(files.id, file.id),
            ),
          );
        const job = await createJobsService({
          database: transaction,
          encryptionKey: input.encryptionKey,
        }).enqueue({
          createdBy,
          principalId,
          idempotencyKey: `extraction:${run.id}:retry:${newId()}`,
          payload: {
            kind: "extraction_execute",
            extractionRunId: run.id,
            fileId: file.id,
          },
          workspaceId: context.workspaceId,
        });
        return { fileId: file.id, runId: run.id, jobId: job.id };
      });
    },
  };
}
