// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  decodeJobPayload,
  encodeJobPayload,
  jobPayloadHash,
} from "@/modules/jobs/service";

const key = "42".repeat(32);
const importId = "019cc7c4-6ed2-7e0a-aed8-e5d451c96bf3";

describe("durable job payloads", () => {
  it("seals only canonical UUID payloads for their exact registered kind", () => {
    const payload = { importId, kind: "import_execute" as const };
    const encoded = encodeJobPayload({ key, payload });

    expect(encoded.encryptedPayload).not.toContain(importId);
    expect(encoded.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(jobPayloadHash(payload)).toBe(encoded.payloadHash);
    expect(
      decodeJobPayload({
        encryptedPayload: encoded.encryptedPayload,
        key,
        kind: "import_execute",
        payloadHash: encoded.payloadHash,
      }),
    ).toEqual(payload);
  });

  it("rejects kind confusion, corruption, and non-UUID payload fields", () => {
    const encoded = encodeJobPayload({
      key,
      payload: { importId, kind: "import_execute" },
    });

    expect(() =>
      decodeJobPayload({
        encryptedPayload: encoded.encryptedPayload,
        key,
        kind: "file_cleanup",
        payloadHash: encoded.payloadHash,
      }),
    ).toThrow("Unable to open protected data");
    expect(() =>
      encodeJobPayload({
        key,
        payload: {
          importId,
          kind: "import_execute",
          sourceRow: "private data",
        } as never,
      }),
    ).toThrow("Invalid job payload");
  });
});
