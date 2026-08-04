import { JobExecutionError, type JobPayload } from "@/modules/jobs/types";
import {
  createImportExecuteService,
  type ImportExecuteJobService,
} from "@/modules/imports/executor";
import type { JobHandler } from "@/worker/registry";

export { createImportExecuteService };
export type { ImportExecuteJobService };

export function createImportExecuteHandler(
  service?: ImportExecuteJobService,
): JobHandler<Extract<JobPayload, { kind: "import_execute" }>> {
  return async (payload, context) => {
    if (!service) {
      throw new JobExecutionError("dependency_unavailable", "retryable");
    }
    if (!context.job.leaseOwner) {
      throw new JobExecutionError("lease_lost", "retryable");
    }
    return service.executeImportJob({
      claimGeneration: context.job.claimGeneration,
      importId: payload.importId,
      jobId: context.job.id,
      leaseOwner: context.job.leaseOwner,
      workspaceId: context.job.workspaceId,
      renewLease: context.renewLease,
      signal: context.signal,
    });
  };
}
