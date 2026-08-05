// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  canonicalJobPayload,
  JobExecutionError,
  jobFailureCode,
  jobPayloadPurpose,
  parseJobPayload,
  safeJobFailureCode,
  type AiExecuteJobPayload,
  type FileCleanupJobPayload,
} from "@/modules/jobs/types";
import { decodeJobPayload, encodeJobPayload } from "@/modules/jobs/service";
import { createJobRegistry } from "@/worker/registry";

const encryptionKey = "42".repeat(32);
const runId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf3";

describe("AI durable job protocol", () => {
  it("allows only stable worker failure codes into durable state", () => {
    expect(safeJobFailureCode("validation_failed")).toBe("validation_failed");
    expect(safeJobFailureCode("cancelled")).toBe("cancelled");
    expect(safeJobFailureCode("extraction_cancelled")).toBe(
      "extraction_cancelled",
    );
    expect(safeJobFailureCode("PROVIDER_UNAVAILABLE")).toBe(
      "provider_unavailable",
    );
    expect(safeJobFailureCode("webhook_http_503")).toBe("webhook_http_503");
    expect(safeJobFailureCode("WEBHOOK_HTTP_503")).toBe("webhook_http_503");
    expect(
      safeJobFailureCode("provider https://ai.example.test/api-key=secret"),
    ).toBe("dependency_unavailable");
    expect(safeJobFailureCode("private_prompt_secret")).toBe(
      "dependency_unavailable",
    );
    expect(
      jobFailureCode(new JobExecutionError("api-key-secret", "permanent")),
    ).toBe("dependency_unavailable");
    expect(jobFailureCode({ extensions: { code: "VALIDATION_FAILED" } })).toBe(
      "validation_failed",
    );
  });

  it("parses and canonicalizes the exact closed ai_execute payload", () => {
    const payload: AiExecuteJobPayload = { kind: "ai_execute", runId };

    expect(parseJobPayload(payload)).toEqual(payload);
    expect(canonicalJobPayload(payload)).toBe(
      `{"kind":"ai_execute","runId":"${runId}"}`,
    );
    expect(jobPayloadPurpose(payload.kind)).toBe("job-ai-execute");
  });

  it("dispatches file-target cleanup jobs through the existing cleanup slot", () => {
    const payload: FileCleanupJobPayload = {
      kind: "file_cleanup",
      fileId: runId,
    };
    const fileCleanup = vi.fn(async () => undefined);
    const registry = createJobRegistry({
      aiExecute: vi.fn(async () => undefined),
      fileCleanup,
      importExecute: vi.fn(async () => undefined),
    });

    expect(parseJobPayload(payload)).toEqual(payload);
    expect(canonicalJobPayload(payload)).toBe(
      `{"kind":"file_cleanup","fileId":"${runId}"}`,
    );
    expect(registry.get(payload)).toBe(fileCleanup);
  });

  it.each([
    null,
    {},
    { kind: "ai_execute" },
    { kind: "ai_execute", runId: "not-a-uuid" },
    { kind: "ai_execute", runId: [runId] },
    { kind: "ai_execute", runId: new String(runId) },
    { kind: "ai_execute", runId: { toString: (): string => runId } },
    { kind: "ai_execute", runId, unexpected: true },
    { kind: "import_execute", runId },
  ])("rejects invalid or open AI payloads", (value) => {
    expect(() => parseJobPayload(value)).toThrow("Invalid job payload");
  });

  it("uses the AI purpose and rejects kind, hash, and ciphertext tampering", () => {
    const encoded = encodeJobPayload({
      key: encryptionKey,
      payload: { kind: "ai_execute", runId },
    });

    expect(
      decodeJobPayload({
        encryptedPayload: encoded.encryptedPayload,
        key: encryptionKey,
        kind: "ai_execute",
        payloadHash: encoded.payloadHash,
      }),
    ).toEqual({ kind: "ai_execute", runId });
    expect(() =>
      decodeJobPayload({
        encryptedPayload: encoded.encryptedPayload,
        key: encryptionKey,
        kind: "import_execute",
        payloadHash: encoded.payloadHash,
      }),
    ).toThrow("Unable to open protected data");
    expect(() =>
      decodeJobPayload({
        encryptedPayload: encoded.encryptedPayload,
        key: encryptionKey,
        kind: "ai_execute",
        payloadHash: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("Unable to open protected data");
    expect(() =>
      decodeJobPayload({
        encryptedPayload: `${encoded.encryptedPayload.slice(0, -1)}x`,
        key: encryptionKey,
        kind: "ai_execute",
        payloadHash: encoded.payloadHash,
      }),
    ).toThrow("Unable to open protected data");
  });

  it("dispatches the exhaustive AI registry slot without changing legacy slots", () => {
    const aiExecute = vi.fn(async () => undefined);
    const fileCleanup = vi.fn(async () => undefined);
    const importExecute = vi.fn(async () => undefined);
    const registry = createJobRegistry({
      aiExecute,
      fileCleanup,
      importExecute,
    });

    expect(registry.get({ kind: "ai_execute", runId })).toBe(aiExecute);
    expect(registry.get({ kind: "file_cleanup", uploadSessionId: runId })).toBe(
      fileCleanup,
    );
    expect(registry.get({ kind: "import_execute", importId: runId })).toBe(
      importExecute,
    );
  });

  it("keeps extraction jobs closed, canonical, and registry-dispatched", () => {
    const payload = {
      kind: "extraction_execute" as const,
      extractionRunId: runId,
      fileId: "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf4",
    };
    const extractionExecute = vi.fn(async () => undefined);
    const registry = createJobRegistry({
      aiExecute: vi.fn(async () => undefined),
      fileCleanup: vi.fn(async () => undefined),
      importExecute: vi.fn(async () => undefined),
      extractionExecute,
    });
    expect(parseJobPayload(payload)).toEqual(payload);
    expect(canonicalJobPayload(payload)).toBe(
      `{"extractionRunId":"${runId}","fileId":"019cc7c4-6ed2-7e0a-aed8-e5d451c96bf4","kind":"extraction_execute"}`,
    );
    expect(registry.get(payload)).toBe(extractionExecute);
    expect(() => parseJobPayload({ ...payload, extra: true })).toThrow(
      "Invalid job payload",
    );
  });
});
