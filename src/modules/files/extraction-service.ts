import { and, eq, isNull } from "drizzle-orm";

import { extractionRuns, files } from "@/db/schema/files";
import { createGraphQLError } from "@/graphql/errors";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { createJobsService } from "@/modules/jobs/service";
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
  };
}
