export const uploadPurposes = [
  "EVIDENCE",
  "CSV_IMPORT",
  "JSON_IMPORT",
] as const;
export type UploadPurpose = (typeof uploadPurposes)[number];

export const uploadSessionStates = [
  "pending",
  "verifying",
  "completed",
  "rejected",
  "expired",
  "cleanup_pending",
] as const;
export type UploadSessionState = (typeof uploadSessionStates)[number];

export const fileAvailabilityStates = [
  "quarantined",
  "available",
  "rejected",
] as const;
export type FileAvailability = (typeof fileAvailabilityStates)[number];

export const fileScanStates = [
  "pending",
  "clean",
  "not_required",
  "infected",
  "error",
] as const;
export type FileScanState = (typeof fileScanStates)[number];

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

export type UploadValidationInput = {
  originalName: string;
  claimedMediaType: string;
  byteSize: number;
  checksumSha256: string;
  purpose: UploadPurpose;
  sensitivity?: Sensitivity | null;
  /** Optional client key for durable create-session replay. */
  idempotencyKey?: string | null;
};

export type ValidatedUpload = UploadValidationInput & {
  sensitivity: Sensitivity;
};
