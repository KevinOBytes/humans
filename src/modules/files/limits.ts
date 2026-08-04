import type { UploadPurpose } from "./types";

const MIB = 1024 * 1024;

export const EVIDENCE_MAX_BYTES = 50 * MIB;
export const CSV_IMPORT_MAX_BYTES = 25 * MIB;
export const JSON_IMPORT_MAX_BYTES = 10 * MIB;
export const HOSTED_PROXY_UPLOAD_MAX_BYTES = 4 * MIB;

export type FileDeploymentMode = "docker" | "vercel";

export function uploadPurposeMaxBytes(purpose: UploadPurpose): number {
  if (purpose === "EVIDENCE") return EVIDENCE_MAX_BYTES;
  if (purpose === "CSV_IMPORT") return CSV_IMPORT_MAX_BYTES;
  if (purpose === "JSON_IMPORT") return JSON_IMPORT_MAX_BYTES;
  throw new TypeError("Invalid upload purpose");
}

export function uploadMaxBytesForDeployment(
  purpose: UploadPurpose,
  deploymentMode: FileDeploymentMode,
): number {
  const purposeLimit = uploadPurposeMaxBytes(purpose);
  return deploymentMode === "vercel"
    ? Math.min(purposeLimit, HOSTED_PROXY_UPLOAD_MAX_BYTES)
    : purposeLimit;
}
