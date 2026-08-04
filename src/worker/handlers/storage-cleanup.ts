import { JobExecutionError, type JobPayload } from "@/modules/jobs/types";
import type { JobHandler } from "@/worker/registry";

export type FileCleanupJobService = {
  executeFileCleanupJob(input: {
    fileId?: string;
    jobId: string;
    renewLease(): Promise<boolean>;
    signal: AbortSignal;
    uploadSessionId?: string;
    workspaceId: string;
  }): Promise<{ resultReferences?: readonly string[] } | void>;
};

export function createFileCleanupHandler(
  service?: FileCleanupJobService,
): JobHandler<Extract<JobPayload, { kind: "file_cleanup" }>> {
  return async (payload, context) => {
    if (!service) {
      throw new JobExecutionError("dependency_unavailable", "retryable");
    }
    return service.executeFileCleanupJob({
      ...("fileId" in payload
        ? { fileId: payload.fileId }
        : { uploadSessionId: payload.uploadSessionId }),
      jobId: context.job.id,
      workspaceId: context.job.workspaceId,
      renewLease: context.renewLease,
      signal: context.signal,
    });
  };
}
