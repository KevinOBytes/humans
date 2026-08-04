import "server-only";

import { createHmac } from "node:crypto";

import { sealEnvelope } from "@/lib/security/sealed-envelope";

export type ProtectedExactInput =
  | { kind: "PHONE"; value: string }
  | { kind: "PERSON_IDENTIFIER"; namespace: string; value: string };

export type PreparedProtectedExactV1 = Readonly<{
  blindIndex: string;
  blindIndexVersion: 1;
  encryptedValue: string;
  namespace: string | null;
}>;

export type ProtectedExactBlindIndexV1 = Readonly<{
  blindIndex: string;
  namespace: string | null;
}>;

const CONTROL_OR_FORMAT = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;
const HMAC_KEY = /^[0-9a-f]{64}$/iu;
const IDENTIFIER_NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INVALID_VALUE = "The protected exact value is invalid.";

type NormalizedProtectedExact = Readonly<{
  canonicalValue: string;
  displayValue: string;
  namespace: string | null;
}>;

function invalidValue(): never {
  throw new TypeError(INVALID_VALUE);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeInput(input: ProtectedExactInput): NormalizedProtectedExact {
  if (!input || typeof input !== "object" || typeof input.value !== "string") {
    return invalidValue();
  }
  if (input.kind === "PHONE") {
    if (utf8Length(input.value) > 64) return invalidValue();
    const displayValue = input.value.normalize("NFKC").trim();
    if (!displayValue || CONTROL_OR_FORMAT.test(displayValue)) {
      return invalidValue();
    }
    let canonicalValue = displayValue.replace(/[ .()\-]/gu, "");
    if (canonicalValue.startsWith("00")) {
      canonicalValue = `+${canonicalValue.slice(2)}`;
    }
    if (!/^\+[1-9][0-9]{7,14}$/u.test(canonicalValue)) {
      return invalidValue();
    }
    return Object.freeze({ canonicalValue, displayValue, namespace: null });
  }
  if (
    input.kind !== "PERSON_IDENTIFIER" ||
    typeof input.namespace !== "string"
  ) {
    return invalidValue();
  }
  const namespace = input.namespace.normalize("NFKC").trim().toLowerCase();
  if (
    utf8Length(namespace) < 1 ||
    utf8Length(namespace) > 64 ||
    !IDENTIFIER_NAMESPACE.test(namespace)
  ) {
    return invalidValue();
  }
  const displayValue = input.value.normalize("NFKC").trim();
  if (
    !displayValue ||
    utf8Length(displayValue) > 256 ||
    CONTROL_OR_FORMAT.test(displayValue)
  ) {
    return invalidValue();
  }
  return Object.freeze({
    canonicalValue: displayValue,
    displayValue,
    namespace,
  });
}

export function normalizeProtectedExactV1(
  input: ProtectedExactInput,
): Readonly<{ canonicalValue: string; namespace: string | null }> {
  const normalized = normalizeInput(input);
  return Object.freeze({
    canonicalValue: normalized.canonicalValue,
    namespace: normalized.namespace,
  });
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function blindIndex(input: {
  canonicalValue: string;
  key: string;
  kind: ProtectedExactInput["kind"];
  namespace: string | null;
  workspaceId: string;
}): string {
  if (!HMAC_KEY.test(input.key) || !UUID.test(input.workspaceId)) {
    return invalidValue();
  }
  const purpose =
    input.kind === "PHONE"
      ? "humans:protected-exact:v1\0phone\0"
      : "humans:protected-exact:v1\0person-identifier\0";
  const hmac = createHmac("sha256", Buffer.from(input.key, "hex"))
    .update(purpose, "utf8")
    .update(lengthPrefixed(input.workspaceId));
  if (input.namespace !== null) hmac.update(lengthPrefixed(input.namespace));
  return hmac.update(lengthPrefixed(input.canonicalValue)).digest("hex");
}

export function deriveProtectedExactBlindIndexV1(input: {
  blindIndexKey: string;
  lookup: ProtectedExactInput;
  workspaceId: string;
}): ProtectedExactBlindIndexV1 {
  const normalized = normalizeInput(input.lookup);
  return Object.freeze({
    blindIndex: blindIndex({
      canonicalValue: normalized.canonicalValue,
      key: input.blindIndexKey,
      kind: input.lookup.kind,
      namespace: normalized.namespace,
      workspaceId: input.workspaceId,
    }),
    namespace: normalized.namespace,
  });
}

export function prepareProtectedExactV1(input: {
  blindIndexKey: string;
  encryptionKey: string;
  lookup: ProtectedExactInput;
  workspaceId: string;
}): PreparedProtectedExactV1 {
  const normalized = normalizeInput(input.lookup);
  const preparedBlindIndex = deriveProtectedExactBlindIndexV1(input);
  const purpose =
    input.lookup.kind === "PHONE"
      ? "protected-phone"
      : "protected-person-identifier";
  return Object.freeze({
    blindIndex: preparedBlindIndex.blindIndex,
    blindIndexVersion: 1,
    encryptedValue: sealEnvelope({
      key: input.encryptionKey,
      plaintext: normalized.displayValue,
      purpose,
    }),
    namespace: preparedBlindIndex.namespace,
  });
}
