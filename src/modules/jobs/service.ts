import { createHash } from "node:crypto";

import { newId } from "@/db/id";
import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import type { Database } from "@/modules/auth/bootstrap-admin";

import { createJobsRepository, type JobRow } from "./repository";
import {
  canonicalJobPayload,
  equalJobHashes,
  isJobKind,
  jobPayloadPurpose,
  parseJobPayload,
  type JobKind,
  type JobPayload,
} from "./types";

export function jobPayloadHash(payload: JobPayload): string {
  return `sha256:${createHash("sha256").update(canonicalJobPayload(payload), "utf8").digest("hex")}`;
}

export function encodeJobPayload(input: { key: string; payload: JobPayload }): {
  encryptedPayload: string;
  payloadHash: string;
} {
  const payload = parseJobPayload(input.payload);
  const plaintext = canonicalJobPayload(payload);
  return {
    encryptedPayload: sealEnvelope({
      key: input.key,
      plaintext,
      purpose: jobPayloadPurpose(payload.kind),
    }),
    payloadHash: jobPayloadHash(payload),
  };
}

export function decodeJobPayload(input: {
  encryptedPayload: string;
  key: string;
  kind: JobKind;
  payloadHash: string;
}): JobPayload {
  const plaintext = openSealedEnvelope({
    key: input.key,
    purpose: jobPayloadPurpose(input.kind),
    token: input.encryptedPayload,
  });
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new Error("Unable to open protected data");
  }
  const payload = parseJobPayload(value, input.kind);
  if (!equalJobHashes(jobPayloadHash(payload), input.payloadHash)) {
    throw new Error("Unable to open protected data");
  }
  return payload;
}

export function createJobsService(input: {
  database: Database;
  encryptionKey: string;
}) {
  const repository = createJobsRepository(input.database);
  return {
    repository,
    async enqueue(inputValue: {
      createdBy?: string | null;
      principalId?: string | null;
      idempotencyKey: string;
      payload: JobPayload;
      priority?: number;
      requestHash?: string;
      scheduledAt?: Date;
      workspaceId: string;
    }): Promise<JobRow> {
      if (
        typeof inputValue.idempotencyKey !== "string" ||
        inputValue.idempotencyKey.length < 1 ||
        inputValue.idempotencyKey.length > 128
      ) {
        throw new TypeError("Invalid durable job idempotency key");
      }
      const payload = parseJobPayload(inputValue.payload);
      if (
        (inputValue.createdBy != null && inputValue.principalId != null) ||
        (payload.kind === "ai_execute" && inputValue.principalId == null)
      ) {
        throw new TypeError("Invalid durable job attribution");
      }
      const encoded = encodeJobPayload({ key: input.encryptionKey, payload });
      const requestHash = inputValue.requestHash ?? encoded.payloadHash;
      if (!/^sha256:[a-f0-9]{64}$/u.test(requestHash)) {
        throw new TypeError("Invalid durable job request hash");
      }
      const created = await repository.enqueue({
        id: newId(),
        workspaceId: inputValue.workspaceId,
        kind: payload.kind,
        encryptedPayload: encoded.encryptedPayload,
        payloadHash: encoded.payloadHash,
        requestHash,
        idempotencyKey: inputValue.idempotencyKey,
        priority: inputValue.priority,
        scheduledAt: inputValue.scheduledAt,
        createdBy: inputValue.createdBy,
        principalId: inputValue.principalId,
      });
      if (created) return created;
      const existing = await repository.getByIdempotency({
        workspaceId: inputValue.workspaceId,
        kind: payload.kind,
        idempotencyKey: inputValue.idempotencyKey,
      });
      if (
        !existing ||
        !equalJobHashes(existing.payloadHash, encoded.payloadHash) ||
        !existing.requestHash ||
        !equalJobHashes(existing.requestHash, requestHash)
      ) {
        throw new TypeError("Durable job idempotency conflict");
      }
      return existing;
    },
    decode(
      row: Pick<JobRow, "encryptedPayload" | "kind" | "payloadHash">,
    ): JobPayload {
      if (!isJobKind(row.kind)) {
        throw new Error("Unable to open protected data");
      }
      return decodeJobPayload({
        encryptedPayload: row.encryptedPayload,
        key: input.encryptionKey,
        kind: row.kind,
        payloadHash: row.payloadHash,
      });
    },
  };
}
