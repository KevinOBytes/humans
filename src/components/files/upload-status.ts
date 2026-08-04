export function completedUploadStatus(file: {
  availability?: string | null;
  originalName?: string | null;
  scanState?: string | null;
}): string {
  const name = file.originalName ?? "File";
  if (
    file.availability === "AVAILABLE" &&
    (file.scanState === "CLEAN" || file.scanState === "NOT_REQUIRED")
  ) {
    return `${name} is verified and available.`;
  }
  if (file.availability === "REJECTED" || file.scanState === "INFECTED") {
    return `${name} was verified but rejected by the security scan.`;
  }
  if (file.scanState === "ERROR") {
    return `${name} was verified but remains quarantined because scanning is unavailable.`;
  }
  return `${name} was verified and remains quarantined pending a clean scan.`;
}
