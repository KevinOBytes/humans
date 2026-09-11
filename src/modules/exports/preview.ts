import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { createGraphQLError } from "@/graphql/errors";

export type ExportRedactionProfile =
  "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
export type ExportPreviewRow = Readonly<{
  id: string;
  values: Readonly<Record<string, unknown>>;
  redactedFields: readonly string[];
}>;
export type ExportPreview = Readonly<{
  workspaceId: string;
  purpose: string;
  caseId: string | null;
  redactionProfile: ExportRedactionProfile;
  rows: readonly ExportPreviewRow[];
  fieldCounts: Readonly<{
    requested: number;
    visible: number;
    redacted: number;
  }>;
  approvalRequired: boolean;
  expiresAt: string;
  commitToken: string;
  /** SHA-256 of the redacted preview. This is not a secret and binds commit. */
  previewHash: string;
  provenanceManifest: readonly Readonly<{
    rowId: string;
    sourceIds: readonly string[];
  }>[];
  governanceSubjects: readonly Readonly<{
    personId: string;
    fieldDefinitionId: string | null;
  }>[];
}>;

const ORDER = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const;
const VERSION = "humans.export-preview.v2";
function invalid(message: string): never {
  throw createGraphQLError("VALIDATION_FAILED", message);
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value)
      ? JSON.stringify(value)
      : invalid("Invalid export value.");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object")
    return invalid("Unsupported export value.");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
function key(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/iu.test(value))
    throw new TypeError("Invalid export preview key");
  return Buffer.from(value, "hex");
}
function signature(payload: string, hmacKey: string): string {
  return createHmac("sha256", key(hmacKey))
    .update(`${VERSION}\0${payload}`, "utf8")
    .digest("base64url");
}

export function issueExportCommitToken(input: {
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  redactionProfile: ExportRedactionProfile;
  previewHash?: string;
  expiresAt: Date;
  hmacKey: string;
}): string {
  const payload = canonical({
    version: VERSION,
    workspaceId: input.workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    purpose: input.purpose,
    caseId: input.caseId ?? null,
    redactionProfile: input.redactionProfile,
    previewHash: input.previewHash ?? null,
    expiresAt: input.expiresAt.toISOString(),
  });
  return `${Buffer.from(payload).toString("base64url")}.${signature(payload, input.hmacKey)}`;
}

export function verifyExportCommitToken(input: {
  token: string;
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  redactionProfile: ExportRedactionProfile;
  previewHash?: string;
  hmacKey: string;
  now?: Date;
}): Date {
  const [encoded, supplied] = input.token.split(".");
  if (!encoded || !supplied) invalid("The export commit token is invalid.");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    invalid("The export commit token is invalid.");
  }
  const raw = canonical(payload);
  const expected = signature(raw, input.hmacKey);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    invalid("The export commit token is invalid.");
  if (
    payload.version !== VERSION ||
    payload.workspaceId !== input.workspaceId ||
    payload.actorPrincipalId !== input.actorPrincipalId ||
    payload.purpose !== input.purpose ||
    (payload.caseId ?? null) !== (input.caseId ?? null) ||
    payload.redactionProfile !== input.redactionProfile ||
    (payload.previewHash ?? null) !== (input.previewHash ?? null)
  )
    invalid("The export commit token scope does not match.");
  const expiresAt = new Date(String(payload.expiresAt ?? ""));
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= (input.now ?? new Date()).getTime()
  )
    invalid("The export commit token has expired.");
  return expiresAt;
}

export function previewExport(input: {
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  redactionProfile: ExportRedactionProfile;
  rows: readonly Readonly<{
    id: string;
    sensitivity?: string | null;
    values: Readonly<Record<string, unknown>>;
    fieldSensitivity?: Readonly<Record<string, string>>;
    sourceIds?: readonly string[];
  }>[];
  hmacKey: string;
  governanceSubjects?: readonly Readonly<{
    personId: string;
    fieldDefinitionId: string | null;
  }>[];
  expiresInMs?: number;
}): ExportPreview {
  if (!input.workspaceId || !input.actorPrincipalId || !input.purpose.trim())
    invalid("Workspace, actor, and purpose are required.");
  if (!ORDER.includes(input.redactionProfile))
    invalid("The redaction profile is invalid.");
  const ceiling = ORDER.indexOf(input.redactionProfile);
  let requested = 0;
  let visible = 0;
  let redacted = 0;
  const rows = input.rows.slice(0, 500).map((row) => {
    const values: Record<string, unknown> = {};
    const redactedFields: string[] = [];
    for (const [field, value] of Object.entries(row.values)) {
      requested += 1;
      const sensitivity = (
        row.fieldSensitivity?.[field] ??
        row.sensitivity ??
        "internal"
      ).toUpperCase();
      if (
        !ORDER.includes(sensitivity as ExportRedactionProfile) ||
        ORDER.indexOf(sensitivity as ExportRedactionProfile) > ceiling
      ) {
        values[field] = null;
        redactedFields.push(field);
        redacted += 1;
      } else {
        values[field] = value;
        visible += 1;
      }
    }
    return { id: row.id, values, redactedFields };
  });
  const expiresAt = new Date(
    Date.now() +
      Math.min(Math.max(input.expiresInMs ?? 15 * 60_000, 60_000), 60 * 60_000),
  );
  const previewHash = createHash("sha256")
    .update(
      canonical({
        caseId: input.caseId ?? null,
        fieldCounts: { requested, visible, redacted },
        purpose: input.purpose.trim(),
        provenanceManifest: input.rows.slice(0, 500).map((row) => ({
          rowId: row.id,
          sourceIds: [...new Set(row.sourceIds ?? [])],
        })),
        redactionProfile: input.redactionProfile,
        rows,
        governanceSubjects: input.governanceSubjects ?? [],
        workspaceId: input.workspaceId,
      }),
    )
    .digest("hex");
  return {
    workspaceId: input.workspaceId,
    purpose: input.purpose.trim(),
    caseId: input.caseId ?? null,
    redactionProfile: input.redactionProfile,
    rows,
    fieldCounts: { requested, visible, redacted },
    approvalRequired:
      input.redactionProfile === "CONFIDENTIAL" ||
      input.redactionProfile === "RESTRICTED" ||
      redacted > 0,
    expiresAt: expiresAt.toISOString(),
    commitToken: issueExportCommitToken({
      workspaceId: input.workspaceId,
      actorPrincipalId: input.actorPrincipalId,
      purpose: input.purpose.trim(),
      caseId: input.caseId,
      redactionProfile: input.redactionProfile,
      previewHash,
      expiresAt,
      hmacKey: input.hmacKey,
    }),
    previewHash,
    provenanceManifest: input.rows.slice(0, 500).map((row) => ({
      rowId: row.id,
      sourceIds: [...new Set(row.sourceIds ?? [])],
    })),
    governanceSubjects: input.governanceSubjects ?? [],
  };
}

export function serializeRedactedExport(
  preview: ExportPreview,
  format: "JSON" | "CSV",
): string {
  if (format === "JSON")
    return JSON.stringify({
      schema: "humans.governed-export.v1",
      purpose: preview.purpose,
      caseId: preview.caseId,
      redactionProfile: preview.redactionProfile,
      rows: preview.rows,
      provenanceManifest: preview.provenanceManifest,
    });
  const columns = [
    ...new Set(preview.rows.flatMap((row) => Object.keys(row.values))),
  ].sort();
  const escape = (value: unknown) => {
    const raw = value == null ? "" : String(value);
    const text = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.join(","),
    ...preview.rows.map((row) =>
      columns.map((column) => escape(row.values[column])).join(","),
    ),
  ].join("\n");
}
