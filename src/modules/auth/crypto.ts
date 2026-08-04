import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AUTH_MATERIAL_ENVELOPE_VERSION = "h1";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_AAD = Buffer.from(AUTH_MATERIAL_ENVELOPE_VERSION, "utf8");
const DECRYPTION_ERROR = "Unable to decrypt protected authentication material";

function parseEncryptionKey(key: string): Buffer {
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/iu.test(key)) {
    throw new Error("Invalid authentication encryption key");
  }

  const parsed = Buffer.from(key, "hex");
  if (parsed.byteLength !== KEY_BYTES) {
    throw new Error("Invalid authentication encryption key");
  }

  return parsed;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error(DECRYPTION_ERROR);
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(DECRYPTION_ERROR);
  }

  return decoded;
}

export async function encryptAuthMaterial(
  plaintext: string,
  encryptionKey: string,
): Promise<string> {
  const key = parseEncryptionKey(encryptionKey);
  const nonce = randomBytes(NONCE_BYTES);

  try {
    const cipher = createCipheriv(ALGORITHM, key, nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(VERSION_AAD);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      AUTH_MATERIAL_ENVELOPE_VERSION,
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");
  } catch {
    throw new Error("Unable to encrypt protected authentication material");
  }
}

export async function decryptAuthMaterial(
  envelope: string,
  encryptionKey: string,
): Promise<string> {
  try {
    const key = parseEncryptionKey(encryptionKey);
    if (typeof envelope !== "string") {
      throw new Error(DECRYPTION_ERROR);
    }

    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== AUTH_MATERIAL_ENVELOPE_VERSION) {
      throw new Error(DECRYPTION_ERROR);
    }

    const [, encodedNonce, encodedCiphertext, encodedTag] = parts;
    const nonce = decodeBase64Url(encodedNonce);
    const ciphertext = decodeBase64Url(encodedCiphertext);
    const tag = decodeBase64Url(encodedTag);

    if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
      throw new Error(DECRYPTION_ERROR);
    }

    const decipher = createDecipheriv(ALGORITHM, key, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(VERSION_AAD);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}
