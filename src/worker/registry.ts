import type { JobRow } from "@/modules/jobs/repository";
import type { JobPayload } from "@/modules/jobs/types";

export type JobHandlerContext = {
  job: JobRow;
  renewLease(): Promise<boolean>;
  signal: AbortSignal;
};

export type JobHandler<Payload extends JobPayload = JobPayload> = (
  payload: Payload,
  context: JobHandlerContext,
) => Promise<{ resultReferences?: readonly string[] } | void>;

export type JobRegistry = {
  get(payload: JobPayload): JobHandler;
};

export function createJobRegistry(input: {
  fileCleanup: JobHandler<Extract<JobPayload, { kind: "file_cleanup" }>>;
  importExecute: JobHandler<Extract<JobPayload, { kind: "import_execute" }>>;
}): JobRegistry {
  return {
    get(payload) {
      switch (payload.kind) {
        case "import_execute":
          return input.importExecute as JobHandler;
        case "file_cleanup":
          return input.fileCleanup as JobHandler;
      }
    },
  };
}
