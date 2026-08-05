import { and, eq, isNull } from "drizzle-orm";

import { extractionRuns, files } from "@/db/schema/files";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { JobExecutionError } from "@/modules/jobs/types";
import type { ObjectStore } from "@/lib/storage/types";

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
  for await (const chunk of read.body) {
    if (signal.aborted)
      throw new JobExecutionError("worker_draining", "retryable");
    bytes += chunk.byteLength;
    if (bytes > MAX_EXTRACTED_BYTES) {
      throw new JobExecutionError("extraction_input_too_large", "permanent");
    }
    chunks.push(Buffer.from(chunk));
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
    if (row.run.state === "completed" || row.run.state === "error")
      return { resultReferences: [row.run.id] };
    if (row.run.state === "pending") {
      const [claimed] = await input.database
        .update(extractionRuns)
        .set({ state: "processing", startedAt: new Date() })
        .where(
          and(
            eq(extractionRuns.id, row.run.id),
            eq(extractionRuns.state, "pending"),
          ),
        )
        .returning({ id: extractionRuns.id });
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
      await input.database.transaction(async (transaction) => {
        await transaction
          .update(extractionRuns)
          .set({
            state: "completed",
            structuredOutput: {
              text: result.text,
              bytes: result.bytes,
              contentType,
            },
            errorSummary: null,
            completedAt: new Date(),
          })
          .where(
            and(
              eq(extractionRuns.id, row.run.id),
              eq(extractionRuns.state, "processing"),
            ),
          );
        await transaction
          .update(files)
          .set({
            extractionState: "completed",
            updatedAt: new Date(),
            version: row.file.version + 1,
          })
          .where(eq(files.id, row.file.id));
      });
      return { resultReferences: [row.run.id, row.file.id] };
    } catch (error) {
      if (
        error instanceof JobExecutionError &&
        error.failureKind === "retryable"
      )
        throw error;
      const failure =
        error instanceof JobExecutionError ? error.code : "extraction_failed";
      await input.database
        .update(extractionRuns)
        .set({
          state: "error",
          errorSummary: { code: failure },
          completedAt: new Date(),
        })
        .where(
          and(
            eq(extractionRuns.id, row.run.id),
            eq(extractionRuns.state, "processing"),
          ),
        );
      if (error instanceof JobExecutionError) throw error;
      throw new JobExecutionError(failure, "permanent");
    }
  };
}
