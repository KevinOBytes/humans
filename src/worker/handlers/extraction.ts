import { and, eq, isNull } from "drizzle-orm";

import { extractionRuns, files } from "@/db/schema/files";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { JobExecutionError, safeJobFailureCode } from "@/modules/jobs/types";
import { ObjectReadLimitError, type ObjectStore } from "@/lib/storage/types";
import { parseExtractionContent } from "@/modules/files/extraction-parser";

const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024;

async function readText(
  objectStore: ObjectStore,
  input: { workspaceId: string; key: string },
  signal: AbortSignal,
): Promise<{ text: string; bytes: number }> {
  const read = await objectStore.openRead(
    { workspaceId: input.workspaceId, key: input.key },
    { maxBytes: MAX_EXTRACTED_BYTES, signal },
  );
  if (!read)
    throw new JobExecutionError("extraction_source_missing", "permanent");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of read.body) {
      if (signal.aborted)
        throw new JobExecutionError("worker_draining", "retryable");
      bytes += chunk.byteLength;
      if (bytes > MAX_EXTRACTED_BYTES) {
        throw new JobExecutionError("extraction_input_too_large", "permanent");
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof ObjectReadLimitError) {
      throw new JobExecutionError("extraction_input_too_large", "permanent");
    }
    throw error;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

export function createExtractionHandler(input: {
  database: Database;
  objectStore: ObjectStore;
}): (
  payload: { extractionRunId: string; fileId: string },
  context: { job: { workspaceId: string }; signal: AbortSignal },
) => Promise<{ resultReferences: readonly string[] }> {
  return async (payload, context) => {
    const [row] = await input.database
      .select({ run: extractionRuns, file: files })
      .from(extractionRuns)
      .innerJoin(
        files,
        and(
          eq(files.workspaceId, extractionRuns.workspaceId),
          eq(files.id, extractionRuns.fileId),
        ),
      )
      .where(
        and(
          eq(extractionRuns.workspaceId, context.job.workspaceId),
          eq(extractionRuns.id, payload.extractionRunId),
          eq(extractionRuns.fileId, payload.fileId),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw new JobExecutionError("extraction_run_not_found", "permanent");
    if (
      row.run.state === "completed" ||
      row.run.state === "error" ||
      row.run.state === "cancelled"
    )
      return { resultReferences: [row.run.id] };
    if (row.run.state === "pending") {
      const claimed = await input.database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(extractionRuns)
          .set({ state: "processing", startedAt: new Date() })
          .where(
            and(
              eq(extractionRuns.workspaceId, context.job.workspaceId),
              eq(extractionRuns.id, row.run.id),
              eq(extractionRuns.state, "pending"),
            ),
          )
          .returning({ id: extractionRuns.id });
        if (!updated) return null;
        await transaction
          .update(files)
          .set({
            extractionState: "processing",
            updatedAt: new Date(),
            version: row.file.version + 1,
          })
          .where(
            and(
              eq(files.workspaceId, context.job.workspaceId),
              eq(files.id, row.file.id),
            ),
          );
        return updated;
      });
      if (!claimed) return { resultReferences: [row.run.id] };
    }
    try {
      if (row.file.quarantineState !== "available") {
        throw new JobExecutionError("extraction_file_unavailable", "permanent");
      }
      const result = await readText(
        input.objectStore,
        { workspaceId: context.job.workspaceId, key: row.file.storageKey },
        context.signal,
      );
      const contentType =
        row.file.detectedType ?? row.file.mediaType ?? "text/plain";
      if (!(
        contentType.startsWith("text/") ||
        /(?:json|csv|xml|javascript)/iu.test(contentType)
      )) {
        throw new JobExecutionError("extraction_type_unsupported", "permanent");
      }
      const structuredOutput = parseExtractionContent({
        bytes: result.bytes,
        contentType,
        extractor: row.run.extractor,
        text: result.text,
      });
      await input.database.transaction(async (transaction) => {
        const [completed] = await transaction
          .update(extractionRuns)
          .set({
            state: "completed",
            structuredOutput: {
              ...structuredOutput,
            },
            errorSummary: null,
            completedAt: new Date(),
          })
          .where(
            and(
              eq(extractionRuns.id, row.run.id),
              eq(extractionRuns.state, "processing"),
            ),
          )
          .returning({ id: extractionRuns.id });
        if (!completed) return;
        await transaction
          .update(files)
          .set({
            extractionState: "completed",
            updatedAt: new Date(),
            version: row.file.version + 1,
          })
          .where(
            and(
              eq(files.workspaceId, context.job.workspaceId),
              eq(files.id, row.file.id),
            ),
          );
      });
      return { resultReferences: [row.run.id, row.file.id] };
    } catch (error) {
      if (
        error instanceof JobExecutionError &&
        error.failureKind === "retryable"
      )
        throw error;
      const failure =
        error instanceof JobExecutionError
          ? safeJobFailureCode(error.code)
          : "extraction_failed";
      await input.database.transaction(async (transaction) => {
        const [failed] = await transaction
          .update(extractionRuns)
          .set({
            state: "error",
            errorSummary: { code: failure },
            completedAt: new Date(),
          })
          .where(
            and(
              eq(extractionRuns.workspaceId, context.job.workspaceId),
              eq(extractionRuns.id, row.run.id),
              eq(extractionRuns.state, "processing"),
            ),
          )
          .returning({ id: extractionRuns.id });
        if (!failed) return;
        await transaction
          .update(files)
          .set({
            extractionState: "error",
            updatedAt: new Date(),
            version: row.file.version + 1,
          })
          .where(
            and(
              eq(files.workspaceId, context.job.workspaceId),
              eq(files.id, row.file.id),
            ),
          );
      });
      if (error instanceof JobExecutionError) throw error;
      throw new JobExecutionError(failure, "permanent");
    }
  };
}
