export type AuditSensitivity =
  "public" | "internal" | "confidential" | "restricted";

const safeMetadataKeys = new Set([
  "state",
  "status",
  "sensitivity",
  "version",
  "relationshipType",
  "reviewState",
]);

export function redactAuditDiff(input: {
  changedFields: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  sensitivity?: AuditSensitivity;
}): Record<string, unknown> {
  const fields = [...new Set(input.changedFields)]
    .filter((field) => /^[a-z][A-Za-z0-9]*$/u.test(field))
    .sort();
  if (
    input.sensitivity === "confidential" ||
    input.sensitivity === "restricted"
  ) {
    return { changed: fields.map((field) => ({ field, changed: true })) };
  }
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (
      safeMetadataKeys.has(key) &&
      (typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        value === null)
    ) {
      metadata[key] = value;
    }
  }
  return {
    changedFields: fields,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
