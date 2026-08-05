import { createHmac, timingSafeEqual } from "node:crypto";

import type { ResearchServiceContext } from "@/modules/audit/service";
import type { AiProviderDisclosure } from "./types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HMAC_KEY = /^[0-9a-f]{64}$/iu;
const MAX_CITATIONS = 64;
const TOOL_SUMMARY_COUNT_KEYS = new Set([
  "evidenceCount",
  "filterCount",
  "personCount",
  "resourceCount",
  "resultCount",
]);
const TOOL_SUMMARY_BOOLEAN_KEYS = new Set(["truncated"]);

export const AI_TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;
export const AI_STABLE_ERROR_CODES = [
  "analysis_cancelled",
  "analysis_limit_reached",
  "authorization_changed",
  "execution_failed",
  "input_unavailable",
  "provider_invalid_response",
  "provider_response_too_large",
  "provider_timeout",
  "provider_unavailable",
] as const;
export type AiStableErrorCode = (typeof AI_STABLE_ERROR_CODES)[number];
const aiStableErrorCodeSet: ReadonlySet<string> = new Set(
  AI_STABLE_ERROR_CODES,
);
const aiFailureCodeMap: Readonly<Record<string, AiStableErrorCode>> = {
  AUTHORIZATION_CHANGED: "authorization_changed",
  CAPABILITY_UNSUPPORTED: "analysis_limit_reached",
  INPUT_UNAVAILABLE: "input_unavailable",
  PROVIDER_ABORTED: "analysis_cancelled",
  PROVIDER_REDIRECTED: "provider_invalid_response",
  PROVIDER_RESPONSE_INVALID: "provider_invalid_response",
  PROVIDER_RESPONSE_TOO_LARGE: "provider_response_too_large",
  PROVIDER_TIMEOUT: "provider_timeout",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
};
export const MAX_AI_PROVIDER_BOUNDARIES = 4;
export const MAX_AI_TOOL_CALLS = 4;
export const MAX_AI_ANSWER_BYTES = 64_000;

export type AiScope = Readonly<{
  evidenceIds: readonly string[];
  personIds: readonly string[];
}>;

export type AiCitation = Readonly<{
  claimText: string;
  locator: string | null;
  resourceId: string;
  resourceKind: "evidence" | "person";
}>;

export type AiToolSummary = Readonly<{
  approvedToolName: string;
  redactedArguments: Readonly<Record<string, unknown>>;
  redactedResultSummary: Readonly<Record<string, unknown>> | null;
  resourceReferences: readonly Readonly<{
    id: string;
    kind: "evidence" | "person";
  }>[];
  state: string;
  startedAt: Date | null;
  completedAt: Date | null;
}>;

export type AiRun = Readonly<{
  answer: string | null;
  citations: readonly AiCitation[];
  completedAt: Date | null;
  createdAt: Date;
  errorCode: string | null;
  id: string;
  model: string;
  provider: AiProviderDisclosure["provider"];
  startedAt: Date | null;
  state: "cancelled" | "completed" | "failed" | "pending" | "running";
  toolCalls: readonly AiToolSummary[];
}>;

export type AiRunHistoryItem = Readonly<{
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  model: string;
  provider: AiProviderDisclosure["provider"];
  startedAt: Date | null;
  state: "cancelled" | "completed" | "failed" | "pending" | "running";
}>;

export type AiRunHistoryCursor = Readonly<{
  createdAt: Date;
  id: string;
}>;

type AiRunHistoryCursorBinding = Readonly<{
  principalId: string;
  workspaceId: string;
}>;

export type AiJobClaim = Readonly<{
  claimGeneration: number;
  jobId: string;
  leaseOwner: string;
  runId: string;
  workspaceId: string;
}>;

export type ClaimedAiRun = Readonly<{
  configurationHash: string;
  model: string;
  principalId: string;
  promptHash: string;
  provider: AiProviderDisclosure["provider"];
  question: string;
  scope: AiScope;
  threadId: string;
}>;

export type AiRepositoryRuntime = Readonly<{
  encryptionKey: string;
  hmacKey: string;
}>;

export type StartAiRowsInput = Readonly<{
  context: ResearchServiceContext;
  provider: AiProviderDisclosure;
  baseUrlFingerprint: string;
  containsRestrictedScope: boolean;
  question: string;
  scope: AiScope;
}>;

const OMITTED_AI_USER_MESSAGE = JSON.stringify({
  question: null,
  scope: { evidenceIds: [], personIds: [] },
  version: 1,
});

export function omittedAiUserMessage(): string {
  return OMITTED_AI_USER_MESSAGE;
}

export function isOmittedAiUserMessage(value: string): boolean {
  return value === OMITTED_AI_USER_MESSAGE;
}

export function validateAiRepositoryRuntime(
  runtime: AiRepositoryRuntime,
): void {
  if (
    !HMAC_KEY.test(runtime.hmacKey) ||
    !HMAC_KEY.test(runtime.encryptionKey)
  ) {
    throw new TypeError("Invalid AI persistence runtime");
  }
}

export function aiPersistenceHmac(
  runtime: AiRepositoryRuntime,
  purpose: string,
  material: string,
): string {
  return createHmac("sha256", Buffer.from(runtime.hmacKey, "hex"))
    .update(`humans:ai-persistence:${purpose}:v1\0`, "utf8")
    .update(material, "utf8")
    .digest("hex");
}

function aiRunHistoryCursorSignature(
  body: string,
  binding: AiRunHistoryCursorBinding,
  hmacKey: string,
): string {
  if (
    !HMAC_KEY.test(hmacKey) ||
    !UUID.test(binding.principalId) ||
    !UUID.test(binding.workspaceId)
  ) {
    throw new TypeError("Invalid AI history cursor");
  }
  return createHmac("sha256", Buffer.from(hmacKey, "hex"))
    .update("humans:ai-run-history-cursor:v1\0", "utf8")
    .update(binding.workspaceId.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(binding.principalId.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

export function encodeAiRunHistoryCursor(
  position: AiRunHistoryCursor,
  binding: AiRunHistoryCursorBinding,
  hmacKey: string,
): string {
  if (
    !(position.createdAt instanceof Date) ||
    Number.isNaN(position.createdAt.getTime()) ||
    !UUID.test(position.id)
  ) {
    throw new TypeError("Invalid AI history cursor");
  }
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      createdAt: position.createdAt.toISOString(),
      id: position.id.toLowerCase(),
    }),
    "utf8",
  ).toString("base64url");
  return `${body}.${aiRunHistoryCursorSignature(body, binding, hmacKey)}`;
}

export function decodeAiRunHistoryCursor(
  cursor: string,
  binding: AiRunHistoryCursorBinding,
  hmacKey: string,
): AiRunHistoryCursor {
  try {
    if (
      typeof cursor !== "string" ||
      cursor.length > 2_048 ||
      !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u.test(cursor)
    ) {
      throw new Error("invalid cursor");
    }
    const [body = "", signature = ""] = cursor.split(".");
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length > 1_024 || bytes.toString("base64url") !== body) {
      throw new Error("invalid cursor");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const createdAt = new Date(String(parsed.createdAt));
    const expected = aiRunHistoryCursorSignature(body, binding, hmacKey);
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      ) ||
      Reflect.ownKeys(parsed).length !== 3 ||
      parsed.v !== 1 ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.createdAt ||
      typeof parsed.id !== "string" ||
      !UUID.test(parsed.id)
    ) {
      throw new Error("invalid cursor");
    }
    return Object.freeze({ createdAt, id: parsed.id.toLowerCase() });
  } catch {
    throw new TypeError("Invalid AI history cursor");
  }
}

export function prefixedAiPersistenceHmac(
  runtime: AiRepositoryRuntime,
  purpose: string,
  material: string,
): string {
  return `sha256:${aiPersistenceHmac(runtime, purpose, material)}`;
}

export function equalAiDigest(left: string, right: string): boolean {
  const valid = /^sha256:[0-9a-f]{64}$/u;
  if (!valid.test(left) || !valid.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalScope(scope: AiScope): string {
  return JSON.stringify({
    evidenceIds: [...scope.evidenceIds],
    personIds: [...scope.personIds],
  });
}

export function canonicalAiUserMessage(
  question: string,
  scope: AiScope,
): string {
  return JSON.stringify({
    question,
    scope: JSON.parse(canonicalScope(scope)) as AiScope,
  });
}

export function parseStoredAiUserMessage(value: string): {
  question: string;
  scope: AiScope;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Unable to open protected data");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Unable to open protected data");
  }
  const record = parsed as Record<string, unknown>;
  const scope = record.scope;
  if (
    Object.keys(record).sort().join(",") !== "question,scope" ||
    typeof record.question !== "string" ||
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope)
  ) {
    throw new Error("Unable to open protected data");
  }
  const scopeRecord = scope as Record<string, unknown>;
  if (
    Object.keys(scopeRecord).sort().join(",") !== "evidenceIds,personIds" ||
    !Array.isArray(scopeRecord.evidenceIds) ||
    !Array.isArray(scopeRecord.personIds) ||
    [...scopeRecord.evidenceIds, ...scopeRecord.personIds].some(
      (id) => typeof id !== "string" || !UUID.test(id),
    )
  ) {
    throw new Error("Unable to open protected data");
  }
  return {
    question: record.question,
    scope: {
      evidenceIds: Object.freeze(scopeRecord.evidenceIds as string[]),
      personIds: Object.freeze(scopeRecord.personIds as string[]),
    },
  };
}

export function validAiProvider(
  value: string,
): value is AiProviderDisclosure["provider"] {
  return value === "OPENAI" || value === "OLLAMA" || value === "COMPATIBLE";
}

export function validAiRunState(value: string): value is AiRun["state"] {
  return ["cancelled", "completed", "failed", "pending", "running"].includes(
    value,
  );
}

export function validateRedactedToolJson(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Invalid redacted tool summary");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length >
      TOOL_SUMMARY_COUNT_KEYS.size + TOOL_SUMMARY_BOOLEAN_KEYS.size ||
    entries.some(([key, item]) => {
      if (TOOL_SUMMARY_COUNT_KEYS.has(key)) {
        return (
          !Number.isSafeInteger(item) ||
          Number(item) < 0 ||
          Number(item) > 10_000
        );
      }
      if (TOOL_SUMMARY_BOOLEAN_KEYS.has(key)) {
        return typeof item !== "boolean";
      }
      return true;
    })
  ) {
    throw new TypeError("Invalid redacted tool summary");
  }
  return structuredClone(value) as Readonly<Record<string, unknown>>;
}

export function isAiStableErrorCode(
  value: unknown,
): value is AiStableErrorCode {
  return typeof value === "string" && aiStableErrorCodeSet.has(value);
}

export function mapAiFailureCode(value: unknown): AiStableErrorCode {
  return typeof value === "string"
    ? (aiFailureCodeMap[value] ?? "execution_failed")
    : "execution_failed";
}

export function validateAiResourceReferences(
  value: unknown,
): readonly { id: string; kind: "evidence" | "person" }[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError("Invalid redacted tool references");
  }
  return Object.freeze(
    value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new TypeError("Invalid redacted tool references");
      }
      const record = item as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "id,kind" ||
        typeof record.id !== "string" ||
        !UUID.test(record.id) ||
        (record.kind !== "person" && record.kind !== "evidence")
      ) {
        throw new TypeError("Invalid redacted tool references");
      }
      return {
        id: record.id.toLowerCase(),
        kind: record.kind as "evidence" | "person",
      };
    }),
  );
}

export function validateAiCitations(
  value: readonly AiCitation[],
): readonly AiCitation[] {
  if (!Array.isArray(value) || value.length > MAX_CITATIONS) {
    throw new TypeError("Invalid AI citations");
  }
  return Object.freeze(
    value.map((citation) => {
      if (
        !citation ||
        typeof citation !== "object" ||
        Array.isArray(citation) ||
        !UUID.test(citation.resourceId) ||
        (citation.resourceKind !== "person" &&
          citation.resourceKind !== "evidence") ||
        typeof citation.claimText !== "string" ||
        Buffer.byteLength(citation.claimText.trim(), "utf8") < 1 ||
        Buffer.byteLength(citation.claimText.trim(), "utf8") > 2_000 ||
        (citation.locator !== null &&
          (typeof citation.locator !== "string" ||
            Buffer.byteLength(citation.locator.trim(), "utf8") > 512))
      ) {
        throw new TypeError("Invalid AI citations");
      }
      return {
        claimText: citation.claimText.normalize("NFKC").trim(),
        locator: citation.locator?.normalize("NFKC").trim() || null,
        resourceId: citation.resourceId.toLowerCase(),
        resourceKind: citation.resourceKind,
      };
    }),
  );
}

export function validateAiJobClaim(input: AiJobClaim): void {
  if (
    !UUID.test(input.workspaceId) ||
    !UUID.test(input.runId) ||
    !UUID.test(input.jobId) ||
    !Number.isSafeInteger(input.claimGeneration) ||
    input.claimGeneration < 1 ||
    typeof input.leaseOwner !== "string" ||
    input.leaseOwner.length < 1 ||
    input.leaseOwner.length > 128
  ) {
    throw new TypeError("Invalid AI job claim");
  }
}
