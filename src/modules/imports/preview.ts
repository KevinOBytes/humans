import { createHmac, timingSafeEqual } from "node:crypto";

import { createGraphQLError } from "@/graphql/errors";
import { parseCsv } from "@/modules/files/extraction-parser";

import { parseImportMapping, projectImportRow } from "./mapper";
import type { ImportFormat, ImportMapping, ImportValue } from "./types";

export type ImportPreviewIssue = Readonly<{
  code: string;
  message: string;
  rowNumber?: number;
  path?: readonly string[];
}>;
export type ImportPreviewRow = Readonly<{
  rowNumber: number;
  externalKey: string | null;
  projected: unknown;
  issues: readonly ImportPreviewIssue[];
  duplicateCandidateIds: readonly string[];
}>;
export type ImportPreview = Readonly<{
  format: ImportFormat | "DOCUMENT";
  workspaceId: string;
  purpose: string;
  caseId: string | null;
  rows: readonly ImportPreviewRow[];
  mapping: ImportMapping | null;
  schemaColumns: readonly string[];
  provenanceDefaults: Readonly<{
    collectedAt: string;
    method: string;
    collectorPrincipalId: string;
  }>;
  commitToken: string;
  mappingHash: string;
  expiresAt: string;
  duplicateStrategy: "FLAG_ONLY";
  issues: readonly ImportPreviewIssue[];
}>;

const MAX_PREVIEW_ROWS = 500;
const TOKEN_VERSION = "humans.import-preview.v1";

function invalid(message: string): never {
  throw createGraphQLError("VALIDATION_FAILED", message);
}
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value)
      ? JSON.stringify(value)
      : invalid("The preview contains an invalid number.");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object")
    return invalid("The preview contains an unsupported value.");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
function secret(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/iu.test(value))
    throw new TypeError("Invalid import preview key");
  return Buffer.from(value, "hex");
}
function sign(value: string, key: string): string {
  return createHmac("sha256", secret(key))
    .update(`${TOKEN_VERSION}\0${value}`, "utf8")
    .digest("base64url");
}
function tokenPayload(input: {
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  mappingHash: string;
  expiresAt: string;
}): string {
  return canonical({
    ...input,
    caseId: input.caseId ?? null,
    version: TOKEN_VERSION,
  });
}

export function issueImportCommitToken(input: {
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  mappingHash: string;
  expiresAt: Date;
  hmacKey: string;
}): string {
  const payload = tokenPayload({
    ...input,
    expiresAt: input.expiresAt.toISOString(),
  });
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload, input.hmacKey)}`;
}

export function verifyImportCommitToken(input: {
  token: string;
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  mappingHash: string;
  hmacKey: string;
  now?: Date;
}): { expiresAt: Date; mappingHash: string } {
  const [encoded, signature] = input.token.split(".");
  if (!encoded || !signature) invalid("The import commit token is invalid.");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    invalid("The import commit token is invalid.");
  }
  const canonicalPayload = canonical(payload);
  const expected = sign(canonicalPayload, input.hmacKey);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    invalid("The import commit token is invalid.");
  if (
    payload.version !== TOKEN_VERSION ||
    payload.workspaceId !== input.workspaceId ||
    payload.actorPrincipalId !== input.actorPrincipalId ||
    payload.purpose !== input.purpose ||
    (payload.caseId ?? null) !== (input.caseId ?? null) ||
    payload.mappingHash !== input.mappingHash
  )
    invalid("The import commit token scope does not match.");
  const expiresAt = new Date(String(payload.expiresAt ?? ""));
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= (input.now ?? new Date()).getTime()
  )
    invalid("The import commit token has expired.");
  return { expiresAt, mappingHash: String(payload.mappingHash) };
}

function records(
  format: ImportFormat | "DOCUMENT",
  content: string,
): { columns: string[]; rows: Record<string, ImportValue>[] } {
  if (format === "CSV") {
    const parsed = parseCsv(content);
    if (!parsed.length) return { columns: [], rows: [] };
    const columns = [...parsed[0]].map((value) => value.trim());
    if (
      !columns.length ||
      columns.some((value) => !value || value.length > 128)
    )
      invalid("The CSV header is invalid.");
    return {
      columns,
      rows: parsed
        .slice(1, MAX_PREVIEW_ROWS + 1)
        .map((row) =>
          Object.fromEntries(
            columns.map((column, index) => [column, row[index] ?? null]),
          ),
        ),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    invalid("The JSON document is invalid.");
  }
  const values = Array.isArray(value) ? value : [value];
  const objects = values.filter(
    (item): item is Record<string, ImportValue> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  if (objects.length !== values.length)
    invalid("Each JSON import record must be an object.");
  const columns = [
    ...new Set(objects.flatMap((item) => Object.keys(item))),
  ].sort();
  return { columns, rows: objects.slice(0, MAX_PREVIEW_ROWS) };
}

export function previewImport(input: {
  workspaceId: string;
  actorPrincipalId: string;
  purpose: string;
  caseId?: string | null;
  format: ImportFormat | "DOCUMENT";
  content: string;
  mapping?: unknown;
  duplicateKeys?: Readonly<Record<string, readonly string[]>>;
  collectorPrincipalId?: string;
  collectedAt?: Date;
  expiresInMs?: number;
  hmacKey: string;
}): ImportPreview {
  if (!input.workspaceId || !input.actorPrincipalId || !input.purpose.trim())
    invalid("Workspace, actor, and purpose are required.");
  if (Buffer.byteLength(input.content, "utf8") > 2_000_000)
    invalid("The import preview exceeds the size limit.");
  if (input.format === "DOCUMENT") {
    const content = input.content.trim();
    if (!content) invalid("The document has no extractable content.");
    input = {
      ...input,
      format: "JSON",
      content: JSON.stringify([{ text: content }]),
    };
  }
  const parsed = records(input.format, input.content);
  let mapping: ImportMapping | null = null;
  const issues: ImportPreviewIssue[] = [];
  if (input.mapping !== undefined) {
    try {
      mapping = parseImportMapping(input.mapping, parsed.columns);
    } catch {
      issues.push({
        code: "MAPPING_INVALID",
        message:
          "The schema mapping is invalid or references a missing column.",
      });
    }
  } else
    issues.push({
      code: "MAPPING_REQUIRED",
      message: "A schema mapping is required before commit.",
    });
  const rows = parsed.rows.map((values, index) => {
    const rowNumber = index + 2;
    const rowIssues: ImportPreviewIssue[] = [];
    let projected: unknown = null;
    let externalKey: string | null = null;
    if (mapping) {
      try {
        projected = projectImportRow(mapping, values);
        externalKey =
          typeof projected === "object" && projected && "rowKey" in projected
            ? String((projected as { rowKey: unknown }).rowKey)
            : null;
      } catch {
        rowIssues.push({
          code: "ROW_INVALID",
          message: "The row cannot be projected by this mapping.",
          rowNumber,
        });
      }
    }
    const duplicateCandidateIds = externalKey
      ? [...(input.duplicateKeys?.[externalKey] ?? [])]
      : [];
    if (duplicateCandidateIds.length)
      rowIssues.push({
        code: "DUPLICATE_CANDIDATE",
        message:
          "A possible duplicate was found; no record will be merged automatically.",
        rowNumber,
      });
    return {
      rowNumber,
      externalKey,
      projected,
      issues: rowIssues,
      duplicateCandidateIds,
    };
  });
  const expiresAt = new Date(
    Date.now() +
      Math.min(Math.max(input.expiresInMs ?? 15 * 60_000, 60_000), 60 * 60_000),
  );
  const mappingHash = createHmac("sha256", secret(input.hmacKey))
    .update(canonical(mapping), "utf8")
    .digest("hex");
  const commitToken = issueImportCommitToken({
    workspaceId: input.workspaceId,
    actorPrincipalId: input.actorPrincipalId,
    purpose: input.purpose.trim(),
    caseId: input.caseId,
    mappingHash,
    expiresAt,
    hmacKey: input.hmacKey,
  });
  return {
    format: input.format,
    workspaceId: input.workspaceId,
    purpose: input.purpose.trim(),
    caseId: input.caseId ?? null,
    rows,
    mapping,
    mappingHash,
    schemaColumns: parsed.columns,
    provenanceDefaults: {
      collectedAt: (input.collectedAt ?? new Date()).toISOString(),
      method: "user_supplied_import_preview",
      collectorPrincipalId:
        input.collectorPrincipalId ?? input.actorPrincipalId,
    },
    commitToken,
    expiresAt: expiresAt.toISOString(),
    duplicateStrategy: "FLAG_ONLY",
    issues,
  };
}

export const MAX_IMPORT_PREVIEW_ROWS = MAX_PREVIEW_ROWS;
