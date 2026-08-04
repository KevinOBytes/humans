import { describe, expect, it } from "vitest";

import {
  decodeLocationCursor,
  encodeLocationCursor,
  normalizeAddress,
  openProtectedContact,
  openProtectedPhone,
  prepareProtectedContact,
  prepareProtectedPhone,
} from "@/modules/locations/domain";

const workspaceId = "019424f0-7a90-7000-8000-000000000001";
const personId = "019424f0-7a90-7000-8000-000000000002";
const encryptionKey = "42".repeat(32);
const hmacKey = "43".repeat(32);

describe("location domain protection", () => {
  it("encrypts and opens a normalized protected phone without retaining plaintext", () => {
    const prepared = prepareProtectedPhone({
      blindIndexKey: hmacKey,
      encryptionKey,
      value: " +1 (202) 555-0100 ",
      workspaceId,
    });

    expect(prepared.encryptedValue).toMatch(/^hs1\./u);
    expect(prepared.encryptedValue).not.toContain("202");
    expect(prepared.blindIndex).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      openProtectedPhone({ encryptionKey, token: prepared.encryptedValue }),
    ).toBe("+1 (202) 555-0100");
  });

  it("fails closed when a protected phone envelope is corrupted", () => {
    expect(() =>
      openProtectedPhone({
        encryptionKey,
        token: "hs1.invalid.invalid.invalid",
      }),
    ).toThrow("Protected contact data is unavailable.");
  });

  it("normalizes email for equality while preserving only encrypted display data", () => {
    const first = prepareProtectedContact({
      blindIndexKey: hmacKey,
      encryptionKey,
      kind: "email",
      value: " Person@Example.COM ",
      workspaceId,
    });
    const second = prepareProtectedContact({
      blindIndexKey: hmacKey,
      encryptionKey,
      kind: "email",
      value: "person@example.com",
      workspaceId,
    });
    expect(first.blindIndex).toBe(second.blindIndex);
    expect(first.requestFingerprint).toBe(second.requestFingerprint);
    expect(first.encryptedValue).not.toContain("Person@Example.COM");
    expect(
      openProtectedContact({
        encryptionKey,
        kind: "email",
        token: first.encryptedValue,
      }),
    ).toBe("Person@Example.COM");
  });

  it("encrypts other contact values without a deterministic searchable index", () => {
    const first = prepareProtectedContact({
      blindIndexKey: hmacKey,
      encryptionKey,
      kind: "other",
      value: "Signal: private-handle",
      workspaceId,
    });
    const second = prepareProtectedContact({
      blindIndexKey: hmacKey,
      encryptionKey,
      kind: "other",
      value: "Signal: private-handle",
      workspaceId,
    });
    expect(first.blindIndexVersion).toBeNull();
    expect(first.blindIndex).not.toBe(second.blindIndex);
    expect(first.requestFingerprint).toBe(second.requestFingerprint);
    expect(
      openProtectedContact({
        encryptionKey,
        kind: "other",
        token: first.encryptedValue,
      }),
    ).toBe("Signal: private-handle");
  });
});

describe("address normalization", () => {
  it("produces stable workspace-bound normalized material and hash", () => {
    const first = normalizeAddress({
      blindIndexKey: hmacKey,
      workspaceId,
      line1: "  123 Main St.  ",
      locality: "Richmond",
      region: " va ",
      postalCode: "23219",
      countryCode: "us",
    });
    const second = normalizeAddress({
      blindIndexKey: hmacKey,
      workspaceId,
      line1: "123 Main St.",
      locality: "RICHMOND",
      region: "VA",
      postalCode: "23219",
      countryCode: "US",
    });

    expect(first.normalizedHash).toBe(second.normalizedHash);
    expect(first.normalizedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.value.countryCode).toBe("US");
    expect(first.value.line1).toBe("123 Main St.");
  });

  it("rejects empty and incomplete coordinate input", () => {
    expect(() =>
      normalizeAddress({ blindIndexKey: hmacKey, workspaceId }),
    ).toThrow("The address is invalid.");
    expect(() =>
      normalizeAddress({
        blindIndexKey: hmacKey,
        workspaceId,
        line1: "123 Main St.",
        latitude: 37.54,
      }),
    ).toThrow("The address is invalid.");
  });
});

describe("location cursors", () => {
  it("binds a cursor to workspace, purpose, order, and parent", () => {
    const cursor = encodeLocationCursor(
      {
        id: "019424f0-7a90-7000-8000-000000000003",
        order: "person-contact-created-desc",
        parentId: personId,
        purpose: "person-contacts",
        sort: "2026-01-01T00:00:00.000Z",
        workspaceId,
      },
      hmacKey,
    );

    expect(
      decodeLocationCursor(cursor, {
        order: "person-contact-created-desc",
        parentId: personId,
        purpose: "person-contacts",
        secret: hmacKey,
        workspaceId,
      }),
    ).toMatchObject({ parentId: personId, workspaceId });
    expect(() =>
      decodeLocationCursor(cursor, {
        order: "person-address-created-desc",
        parentId: personId,
        purpose: "person-addresses",
        secret: hmacKey,
        workspaceId,
      }),
    ).toThrow("The location cursor is invalid.");
    expect(() =>
      decodeLocationCursor(`${cursor.slice(0, -1)}0`, {
        order: "person-contact-created-desc",
        parentId: personId,
        purpose: "person-contacts",
        secret: hmacKey,
        workspaceId,
      }),
    ).toThrow("The location cursor is invalid.");
  });
});
