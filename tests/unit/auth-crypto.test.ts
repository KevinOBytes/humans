import { describe, expect, it } from "vitest";

import {
  AUTH_MATERIAL_ENVELOPE_VERSION,
  decryptAuthMaterial,
  encryptAuthMaterial,
} from "@/modules/auth/crypto";

const key = "10".repeat(32);
const wrongKey = "20".repeat(32);
const plaintext = "otpauth://totp/Humans:test@example.test?secret=TOPSECRET";

describe("authentication material encryption", () => {
  it("round trips protected material", async () => {
    const encrypted = await encryptAuthMaterial(plaintext, key);
    await expect(decryptAuthMaterial(encrypted, key)).resolves.toBe(plaintext);
  });

  it("uses a fresh nonce for every encryption", async () => {
    const first = await encryptAuthMaterial(plaintext, key);
    const second = await encryptAuthMaterial(plaintext, key);
    expect(first).not.toBe(second);
  });

  it("uses the versioned nonce.ciphertext.tag envelope", async () => {
    const encrypted = await encryptAuthMaterial(plaintext, key);
    const [version, nonce, ciphertext, tag] = encrypted.split(".");

    expect(version).toBe(AUTH_MATERIAL_ENVELOPE_VERSION);
    expect(Buffer.from(nonce, "base64url")).toHaveLength(12);
    expect(ciphertext).not.toBe("");
    expect(Buffer.from(tag, "base64url")).toHaveLength(16);
  });

  it("does not include plaintext or private key material", async () => {
    const encrypted = await encryptAuthMaterial(plaintext, key);
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted).not.toContain("TOPSECRET");
    expect(encrypted).not.toContain(key);
  });

  it("fails generically for a wrong key and modified envelope", async () => {
    const encrypted = await encryptAuthMaterial(plaintext, key);
    const parts = encrypted.split(".");
    const modified = [...parts.slice(0, 2), `${parts[2]}A`, parts[3]].join(".");

    await expect(decryptAuthMaterial(encrypted, wrongKey)).rejects.toThrow(
      "Unable to decrypt protected authentication material",
    );
    await expect(decryptAuthMaterial(modified, key)).rejects.toThrow(
      "Unable to decrypt protected authentication material",
    );
  });

  it("validates envelope versions and key shape without leaking details", async () => {
    const encrypted = await encryptAuthMaterial(plaintext, key);
    const unsupported = encrypted.replace(
      `${AUTH_MATERIAL_ENVELOPE_VERSION}.`,
      "h999.",
    );

    await expect(decryptAuthMaterial(unsupported, key)).rejects.toThrow(
      "Unable to decrypt protected authentication material",
    );
    await expect(encryptAuthMaterial(plaintext, "short")).rejects.toThrow(
      "Invalid authentication encryption key",
    );
  });

  it.each([
    "",
    "h1",
    "h1.not-base64!.ciphertext.tag",
    "h1.dG9vLXNob3J0.ciphertext.dG9vLXNob3J0",
    "h1.extra.parts.make.the.envelope.too.long",
  ])("fails generically for malformed input: %s", async (malformed) => {
    await expect(decryptAuthMaterial(malformed, key)).rejects.toThrow(
      "Unable to decrypt protected authentication material",
    );
  });

  it("uses the same generic decrypt error for malformed keys", async () => {
    await expect(decryptAuthMaterial("h1.a.b.c", "short")).rejects.toThrow(
      "Unable to decrypt protected authentication material",
    );
  });
});
