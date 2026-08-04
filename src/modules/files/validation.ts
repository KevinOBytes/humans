import { fileTypeFromBuffer } from "file-type";
import { createHash } from "node:crypto";

import { parseImportStream } from "@/modules/imports/parser";

import type {
  FileAvailability,
  FileScanState,
  UploadPurpose,
  UploadValidationInput,
  ValidatedUpload,
} from "./types";

export const EVIDENCE_MAX_BYTES = 50 * 1024 * 1024;
export const CSV_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
export const JSON_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_COMPLETION_CAPACITY = 50;
const MIB = 1024 * 1024;

export function uploadCompletionCost(byteSize: number): number {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) {
    throw new TypeError("Invalid upload byte size");
  }
  return Math.max(1, Math.ceil(byteSize / MIB));
}

const nameControlOrBidi =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const activeText = /^\s*(?:<!doctype\s+html|<html|<script|<svg|<\?xml)/iu;

const mediaMatrix: Readonly<
  Record<UploadPurpose, Readonly<Record<string, readonly string[]>>>
> = {
  EVIDENCE: {
    ".pdf": ["application/pdf"],
    ".png": ["image/png"],
    ".jpg": ["image/jpeg"],
    ".jpeg": ["image/jpeg"],
    ".webp": ["image/webp"],
    ".txt": ["text/plain"],
  },
  CSV_IMPORT: { ".csv": ["text/csv"] },
  JSON_IMPORT: { ".json": ["application/json"] },
};

function invalid(message: string): never {
  throw new TypeError(message);
}

export function uploadPurposeMaxBytes(purpose: UploadPurpose): number {
  if (purpose === "EVIDENCE") return EVIDENCE_MAX_BYTES;
  if (purpose === "CSV_IMPORT") return CSV_IMPORT_MAX_BYTES;
  if (purpose === "JSON_IMPORT") return JSON_IMPORT_MAX_BYTES;
  return invalid("Invalid upload purpose");
}

export function normalizeUploadName(value: string): string {
  if (typeof value !== "string") return invalid("Invalid upload name");
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 255 ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.endsWith(" ") ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    nameControlOrBidi.test(normalized) ||
    windowsDevice.test(normalized)
  ) {
    return invalid("Invalid upload name");
  }
  return normalized;
}

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

export function validateUploadRequest(
  input: UploadValidationInput,
): ValidatedUpload {
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1) {
    return invalid("Invalid upload size");
  }
  if (input.byteSize > uploadPurposeMaxBytes(input.purpose)) {
    return invalid("Upload size exceeds the purpose limit");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.checksumSha256)) {
    return invalid("Invalid upload checksum");
  }
  const originalName = normalizeUploadName(input.originalName);
  const allowed = mediaMatrix[input.purpose]?.[extension(originalName)];
  if (!allowed?.includes(input.claimedMediaType)) {
    return invalid("Invalid upload media type");
  }
  const sensitivity = input.sensitivity ?? "internal";
  if (
    !["public", "internal", "confidential", "restricted"].includes(sensitivity)
  ) {
    return invalid("Invalid upload sensitivity");
  }
  return { ...input, originalName, sensitivity };
}

function decodeText(bytes: Uint8Array): string {
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0 &&
      bytes[1] === 0 &&
      bytes[2] === 0xfe &&
      bytes[3] === 0xff) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
  ) {
    return invalid("UTF-16 and UTF-32 content is not accepted");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("Invalid UTF-8 content");
  }
  if (text.includes("\0")) return invalid("NUL content is not accepted");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function validateUploadContent(input: {
  bytes: Uint8Array;
  originalName: string;
  claimedMediaType: string;
  purpose: UploadPurpose;
}): Promise<{ detectedType: string; text?: string }> {
  const originalName = normalizeUploadName(input.originalName);
  const allowed = mediaMatrix[input.purpose]?.[extension(originalName)];
  if (!allowed?.includes(input.claimedMediaType)) {
    return invalid("Upload type does not match its purpose");
  }
  if (
    input.claimedMediaType === "text/plain" ||
    input.claimedMediaType === "text/csv" ||
    input.claimedMediaType === "application/json"
  ) {
    const text = decodeText(input.bytes);
    if (activeText.test(text)) return invalid("Active content is not accepted");
    return { detectedType: input.claimedMediaType, text };
  }
  const detected = await fileTypeFromBuffer(input.bytes);
  if (!detected || detected.mime !== input.claimedMediaType) {
    return invalid("Detected content type does not match the upload type");
  }
  return { detectedType: detected.mime };
}

export function assertFileTransition(
  from: FileAvailability,
  to: FileAvailability,
  scanState: FileScanState,
): void {
  if (from !== "quarantined" || !["available", "rejected"].includes(to)) {
    return invalid("Invalid file transition");
  }
  if (
    to === "available" &&
    scanState !== "clean" &&
    scanState !== "not_required"
  ) {
    return invalid("File scan state does not allow availability");
  }
  if (to === "rejected" && scanState !== "infected") {
    return invalid("File scan state does not allow rejection");
  }
}

export function strictUtf8Text(bytes: Uint8Array): string {
  return decodeText(bytes);
}

export async function verifyUploadStream(input: {
  stream: AsyncIterable<Uint8Array>;
  originalName: string;
  claimedMediaType: string;
  purpose: UploadPurpose;
  expectedBytes: number;
  expectedChecksumSha256: string;
}): Promise<{ byteSize: number; checksum: string; detectedType: string }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  const prefix: Buffer[] = [];
  let prefixBytes = 0;
  const counted = (async function* () {
    for await (const raw of input.stream) {
      const chunk = Buffer.from(raw);
      byteSize += chunk.byteLength;
      if (byteSize > input.expectedBytes) {
        throw new TypeError("Stored object exceeds the expected size");
      }
      hash.update(chunk);
      if (prefixBytes < 8_192) {
        const slice = chunk.subarray(0, 8_192 - prefixBytes);
        prefix.push(slice);
        prefixBytes += slice.byteLength;
      }
      yield chunk;
    }
  })();

  let detectedType: string;
  if (input.purpose === "CSV_IMPORT" || input.purpose === "JSON_IMPORT") {
    await parseImportStream({
      format: input.purpose === "CSV_IMPORT" ? "CSV" : "JSON",
      stream: counted,
      onRow: () => undefined,
    });
    detectedType = input.claimedMediaType;
  } else if (input.claimedMediaType === "text/plain") {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let textPrefix = "";
    try {
      for await (const chunk of counted) {
        const text = decoder.decode(chunk, { stream: true });
        if (text.includes("\0")) invalid("NUL content is not accepted");
        if (textPrefix.length < 8_192) textPrefix += text.slice(0, 8_192);
      }
      textPrefix += decoder.decode();
    } catch (error) {
      if (error instanceof TypeError) throw error;
      invalid("Invalid UTF-8 content");
    }
    if (activeText.test(textPrefix)) invalid("Active content is not accepted");
    detectedType = input.claimedMediaType;
  } else {
    for await (const chunk of counted) {
      // Only the bounded prefix is retained while the whole object is hashed.
      void chunk;
    }
    const verified = await validateUploadContent({
      bytes: Buffer.concat(prefix),
      originalName: input.originalName,
      claimedMediaType: input.claimedMediaType,
      purpose: input.purpose,
    });
    detectedType = verified.detectedType;
  }
  const checksum = hash.digest("hex");
  if (
    byteSize !== input.expectedBytes ||
    checksum !== input.expectedChecksumSha256
  ) {
    invalid("Stored object size or checksum does not match the upload session");
  }
  return { byteSize, checksum: `sha256:${checksum}`, detectedType };
}
