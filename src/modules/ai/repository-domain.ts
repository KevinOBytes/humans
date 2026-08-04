import { createHmac, timingSafeEqual } from "node:crypto";

import type { ResearchServiceContext } from "@/modules/audit/service";
import type { AiProviderDisclosure } from "./types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HMAC_KEY = /^[0-9a-f]{64}$/iu;
const REDACTED_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const SENSITIVE_REDACTED_KEY =
  /(?:api.?key|base.?url|content|credential|error|exception|message|prompt|query|raw|request|response|secret|token|url)/iu;
const MAX_REDACTED_BYTES = 16_384;
const MAX_REDACTED_NODES = 512;
const MAX_REDACTED_DEPTH = 8;
const MAX_CITATIONS = 64;

export const AI_TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;
export const AI_STABLE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
export const MAX_AI_TOOL_CALLS = 64;
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
  question: string;
  scope: AiScope;
}>;

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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid redacted tool summary");
  }
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_REDACTED_NODES || depth > MAX_REDACTED_DEPTH) {
      throw new TypeError("Invalid redacted tool summary");
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string" && Buffer.byteLength(item, "utf8") <= 512)
      return;
    if (Array.isArray(item)) {
      if (item.length > 64)
        throw new TypeError("Invalid redacted tool summary");
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (
      !item ||
      typeof item !== "object" ||
      Object.getPrototypeOf(item) !== Object.prototype
    ) {
      throw new TypeError("Invalid redacted tool summary");
    }
    const entries = Object.entries(item as Record<string, unknown>);
    if (
      entries.length > 64 ||
      entries.some(
        ([key]) => !REDACTED_KEY.test(key) || SENSITIVE_REDACTED_KEY.test(key),
      )
    ) {
      throw new TypeError("Invalid redacted tool summary");
    }
    for (const [, child] of entries) visit(child, depth + 1);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_REDACTED_BYTES) {
    throw new TypeError("Invalid redacted tool summary");
  }
  return structuredClone(value) as Readonly<Record<string, unknown>>;
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
