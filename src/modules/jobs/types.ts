import { timingSafeEqual } from "node:crypto";

export const jobKinds = [
  "import_execute",
  "file_cleanup",
  "ai_execute",
] as const;
export type JobKind = (typeof jobKinds)[number];

export const jobStates = [
  "queued",
  "running",
  "completed",
  "dead_letter",
] as const;
export type JobState = (typeof jobStates)[number];

export type ImportExecuteJobPayload = {
  kind: "import_execute";
  importId: string;
};

export type FileCleanupJobPayload =
  | { kind: "file_cleanup"; fileId: string; uploadSessionId?: never }
  | { kind: "file_cleanup"; uploadSessionId: string; fileId?: never };

export type AiExecuteJobPayload = Readonly<{
  kind: "ai_execute";
  runId: string;
}>;

export type JobPayload =
  ImportExecuteJobPayload | FileCleanupJobPayload | AiExecuteJobPayload;

export const MAX_JOB_ATTEMPTS = 5;
export const JOB_LEASE_MS = 60_000;
export const MAX_RUN_ONCE_JOBS = 25;
export const MAX_RUN_ONCE_MS = 25_000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && jobKinds.includes(value as JobKind);
}

export function jobPayloadPurpose(kind: JobKind): string {
  return `job-${kind.replaceAll("_", "-")}`;
}

export function parseJobPayload(value: unknown, kind?: JobKind): JobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid job payload");
  }
  const record = value as Record<string, unknown>;
  if (!isJobKind(record.kind) || (kind && record.kind !== kind)) {
    throw new TypeError("Invalid job payload");
  }
  if (record.kind === "import_execute") {
    if (
      Object.keys(record).length !== 2 ||
      !UUID.test(String(record.importId ?? ""))
    ) {
      throw new TypeError("Invalid job payload");
    }
    return {
      kind: record.kind,
      importId: String(record.importId).toLowerCase(),
    };
  }
  if (record.kind === "ai_execute") {
    if (
      Object.keys(record).length !== 2 ||
      typeof record.runId !== "string" ||
      !UUID.test(record.runId)
    ) {
      throw new TypeError("Invalid job payload");
    }
    return {
      kind: record.kind,
      runId: record.runId.toLowerCase(),
    };
  }
  if (Object.keys(record).length !== 2)
    throw new TypeError("Invalid job payload");
  if (typeof record.fileId === "string" && UUID.test(record.fileId)) {
    return { kind: record.kind, fileId: record.fileId.toLowerCase() };
  }
  if (
    typeof record.uploadSessionId === "string" &&
    UUID.test(record.uploadSessionId)
  ) {
    return {
      kind: record.kind,
      uploadSessionId: record.uploadSessionId.toLowerCase(),
    };
  }
  throw new TypeError("Invalid job payload");
}

export function canonicalJobPayload(payload: JobPayload): string {
  const parsed = parseJobPayload(payload);
  switch (parsed.kind) {
    case "import_execute":
      return JSON.stringify({ importId: parsed.importId, kind: parsed.kind });
    case "file_cleanup":
      return "fileId" in parsed
        ? JSON.stringify({ kind: parsed.kind, fileId: parsed.fileId })
        : JSON.stringify({
            kind: parsed.kind,
            uploadSessionId: parsed.uploadSessionId,
          });
    case "ai_execute":
      return JSON.stringify({ kind: parsed.kind, runId: parsed.runId });
  }
}

export function equalJobHashes(left: string, right: string): boolean {
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(left) ||
    !/^sha256:[a-f0-9]{64}$/u.test(right)
  ) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export type JobFailureKind = "permanent" | "retryable";

export class JobExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly failureKind: JobFailureKind,
  ) {
    super("Durable job execution failed");
  }
}

/** A successful bounded slice that must be requeued without consuming retry budget. */
export class JobSliceDeferred extends Error {
  constructor() {
    super("Durable job slice deferred");
  }
}

export function isPermanentJobError(error: unknown): boolean {
  if (error instanceof JobExecutionError)
    return error.failureKind === "permanent";
  const code =
    error && typeof error === "object"
      ? (error as { extensions?: { code?: unknown } }).extensions?.code
      : undefined;
  return (
    code === "FORBIDDEN" ||
    code === "NOT_FOUND" ||
    code === "PRECONDITION_FAILED" ||
    code === "VALIDATION_FAILED"
  );
}

export function jobFailureCode(error: unknown): string {
  if (error instanceof JobExecutionError) return error.code;
  const code =
    error && typeof error === "object"
      ? (error as { extensions?: { code?: unknown } }).extensions?.code
      : undefined;
  return typeof code === "string" && /^[A-Z_]{1,64}$/u.test(code)
    ? code.toLowerCase()
    : "dependency_unavailable";
}
