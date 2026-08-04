import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "hs1";
const MAX_PLAINTEXT_BYTES = 65_536;
const MAX_ENVELOPE_BYTES = 131_072;
const PURPOSE = /^[a-z][a-z0-9-]{0,63}$/u;
const KEY = /^[0-9a-f]{64}$/iu;
const ENCRYPT_ERROR = "Unable to seal protected data";
const DECRYPT_ERROR = "Unable to open protected data";

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error(DECRYPT_ERROR);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error(DECRYPT_ERROR);
  return decoded;
}

function aad(purpose: string): Buffer {
  if (!PURPOSE.test(purpose)) throw new TypeError("Invalid envelope purpose");
  return Buffer.from(`humans:${VERSION}:${purpose}`, "utf8");
}

function encryptionKey(value: string, message: string): Buffer {
  if (!KEY.test(value)) throw new Error(message);
  return Buffer.from(value, "hex");
}

export function sealEnvelope(input: {
  key: string;
  plaintext: string;
  purpose: string;
}): string {
  try {
    const bytes = Buffer.from(input.plaintext, "utf8");
    if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw new Error(ENCRYPT_ERROR);
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      encryptionKey(input.key, ENCRYPT_ERROR),
      nonce,
    );
    cipher.setAAD(aad(input.purpose));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const token = [
      VERSION,
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
    if (Buffer.byteLength(token, "utf8") > MAX_ENVELOPE_BYTES)
      throw new Error(ENCRYPT_ERROR);
    return token;
  } catch {
    throw new Error(ENCRYPT_ERROR);
  }
}

export function openSealedEnvelope(input: {
  key: string;
  purpose: string;
  token: string;
}): string {
  try {
    if (
      typeof input.token !== "string" ||
      Buffer.byteLength(input.token, "utf8") > MAX_ENVELOPE_BYTES
    ) {
      throw new Error(DECRYPT_ERROR);
    }
    const parts = input.token.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION)
      throw new Error(DECRYPT_ERROR);
    const nonce = decode(parts[1]!);
    const ciphertext = decode(parts[2]!);
    const tag = decode(parts[3]!);
    if (
      nonce.byteLength !== 12 ||
      tag.byteLength !== 16 ||
      ciphertext.byteLength > MAX_PLAINTEXT_BYTES
    ) {
      throw new Error(DECRYPT_ERROR);
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(input.key, DECRYPT_ERROR),
      nonce,
    );
    decipher.setAAD(aad(input.purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(DECRYPT_ERROR);
  }
}
