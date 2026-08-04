import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  openSealedEnvelope,
  sealEnvelope,
} from "@/lib/security/sealed-envelope";
import {
  normalizeProtectedExactV1,
  prepareProtectedExactV1,
} from "@/lib/security/protected-exact";

const HEX_KEY = /^[0-9a-f]{64}$/iu;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_COMPONENT = /^[a-z][a-z0-9-]{0,63}$/u;
const COUNTRY_CODE = /^[A-Z]{2}$/u;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}]*$/u;
const ADDRESS_ERROR = "The address is invalid.";
const CURSOR_ERROR = "The location cursor is invalid.";

export type NormalizedAddressValue = Readonly<{
  countryCode: string | null;
  latitude: string | null;
  line1: string | null;
  line2: string | null;
  locality: string | null;
  longitude: string | null;
  postalCode: string | null;
  region: string | null;
  unstructuredText: string | null;
}>;

export type ContactKind = "email" | "other" | "phone";
export type PreparedContact = Readonly<{
  blindIndex: string;
  blindIndexVersion: 1 | null;
  encryptedValue: string;
  requestFingerprint: string;
}>;

export type LocationCursorPayload = Readonly<{
  id: string;
  order: string;
  parentId: string;
  purpose: string;
  sort: string;
  workspaceId: string;
}>;

function invalidAddress(): never {
  throw new TypeError(ADDRESS_ERROR);
}

function invalidCursor(): never {
  throw new TypeError(CURSOR_ERROR);
}

function key(value: string): Buffer {
  if (!HEX_KEY.test(value)) return invalidCursor();
  return Buffer.from(value, "hex");
}

function component(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([prefix, bytes]);
}

function digest(secret: string, domain: string, values: readonly string[]) {
  const hmac = createHmac("sha256", key(secret));
  hmac.update(`${domain}\0`, "utf8");
  for (const value of values) hmac.update(component(value));
  return hmac.digest("hex");
}

function text(value: unknown, maxBytes: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return invalidAddress();
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    !normalized ||
    !SAFE_TEXT.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > maxBytes
  )
    return invalidAddress();
  return normalized;
}

function coordinate(value: unknown, min: number, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    return invalidAddress();
  if (value < min || value > max) return invalidAddress();
  return value.toFixed(6);
}

export function prepareProtectedPhone(input: {
  blindIndexKey: string;
  encryptionKey: string;
  value: string;
  workspaceId: string;
}) {
  return prepareProtectedContact({ ...input, kind: "phone" });
}

export function openProtectedPhone(input: {
  encryptionKey: string;
  token: string;
}): string {
  return openProtectedContact({ ...input, kind: "phone" });
}

function normalizedContact(input: { kind: ContactKind; value: string }): {
  canonical: string;
  display: string;
} {
  if (input.kind === "phone") {
    const normalized = normalizeProtectedExactV1({
      kind: "PHONE",
      value: input.value,
    });
    const display = input.value.normalize("NFKC").trim();
    return { canonical: normalized.canonicalValue, display };
  }
  if (typeof input.value !== "string") throw new TypeError("Invalid contact");
  const display = input.value.normalize("NFKC").trim();
  if (
    !display ||
    !SAFE_TEXT.test(display) ||
    Buffer.byteLength(display, "utf8") > (input.kind === "email" ? 320 : 2_000)
  ) {
    throw new TypeError("Invalid contact");
  }
  if (input.kind === "email") {
    const at = display.lastIndexOf("@");
    if (at <= 0 || at === display.length - 1) {
      throw new TypeError("Invalid contact");
    }
    const local = display.slice(0, at);
    const domain = display.slice(at + 1).toLowerCase();
    if (
      Buffer.byteLength(local, "utf8") > 64 ||
      Buffer.byteLength(domain, "utf8") > 255 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/u.test(domain) ||
      !domain.includes(".") ||
      domain.includes("..")
    ) {
      throw new TypeError("Invalid contact");
    }
    return { canonical: `${local.toLowerCase()}@${domain}`, display };
  }
  return { canonical: display, display };
}

export function prepareProtectedContact(input: {
  blindIndexKey: string;
  encryptionKey: string;
  kind: ContactKind;
  value: string;
  workspaceId: string;
}): PreparedContact {
  const normalized = normalizedContact(input);
  if (input.kind === "phone") {
    const exact = prepareProtectedExactV1({
      blindIndexKey: input.blindIndexKey,
      encryptionKey: input.encryptionKey,
      lookup: { kind: "PHONE", value: input.value },
      workspaceId: input.workspaceId,
    });
    return Object.freeze({
      blindIndex: exact.blindIndex,
      blindIndexVersion: 1,
      encryptedValue: exact.encryptedValue,
      requestFingerprint: digest(
        input.blindIndexKey,
        "humans:contact-request:v1",
        [input.workspaceId, input.kind, normalized.canonical],
      ),
    });
  }
  const requestFingerprint = digest(
    input.blindIndexKey,
    "humans:contact-request:v1",
    [input.workspaceId, input.kind, normalized.canonical],
  );
  const searchable = input.kind === "email";
  return Object.freeze({
    blindIndex: searchable
      ? digest(input.blindIndexKey, "humans:contact-email:v1", [
          input.workspaceId,
          normalized.canonical,
        ])
      : randomBytes(32).toString("hex"),
    blindIndexVersion: searchable ? 1 : null,
    encryptedValue: sealEnvelope({
      key: input.encryptionKey,
      plaintext: normalized.display,
      purpose:
        input.kind === "email" ? "protected-email" : "protected-contact-other",
    }),
    requestFingerprint,
  });
}

export function openProtectedContact(input: {
  encryptionKey: string;
  kind: ContactKind;
  token: string;
}): string {
  try {
    return openSealedEnvelope({
      key: input.encryptionKey,
      purpose:
        input.kind === "phone"
          ? "protected-phone"
          : input.kind === "email"
            ? "protected-email"
            : "protected-contact-other",
      token: input.token,
    });
  } catch {
    throw new Error("Protected contact data is unavailable.");
  }
}

export function normalizeAddress(input: {
  blindIndexKey: string;
  workspaceId: string;
  line1?: string | null;
  line2?: string | null;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  unstructuredText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): { normalizedHash: string; value: NormalizedAddressValue } {
  if (!HEX_KEY.test(input.blindIndexKey) || !UUID.test(input.workspaceId))
    return invalidAddress();
  const countryCode = text(input.countryCode, 2)?.toUpperCase() ?? null;
  if (countryCode && !COUNTRY_CODE.test(countryCode)) return invalidAddress();
  const latitude = coordinate(input.latitude, -90, 90);
  const longitude = coordinate(input.longitude, -180, 180);
  if ((latitude === null) !== (longitude === null)) return invalidAddress();
  const value: NormalizedAddressValue = Object.freeze({
    line1: text(input.line1, 500),
    line2: text(input.line2, 500),
    locality: text(input.locality, 300),
    region: text(input.region, 300),
    postalCode: text(input.postalCode, 64),
    countryCode,
    unstructuredText: text(input.unstructuredText, 4_000),
    latitude,
    longitude,
  });
  if (!value.line1 && !value.unstructuredText) return invalidAddress();
  const normalized = [
    value.line1,
    value.line2,
    value.locality,
    value.region,
    value.postalCode,
    value.countryCode,
    value.unstructuredText,
    value.latitude,
    value.longitude,
  ]
    .map((part) => part?.toLocaleLowerCase("und") ?? "")
    .join("\0");
  return {
    normalizedHash: digest(
      input.blindIndexKey,
      "humans:address-normalized:v1",
      [input.workspaceId.toLowerCase(), normalized],
    ),
    value,
  };
}

function validateCursorPayload(value: unknown): LocationCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalidCursor();
  const payload = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(payload).length !== 8 ||
    payload.v !== 1 ||
    payload.p !== "humans.location.cursor.v1" ||
    typeof payload.id !== "string" ||
    !UUID.test(payload.id) ||
    typeof payload.workspaceId !== "string" ||
    !UUID.test(payload.workspaceId) ||
    typeof payload.parentId !== "string" ||
    !UUID.test(payload.parentId) ||
    typeof payload.order !== "string" ||
    !CURSOR_COMPONENT.test(payload.order) ||
    typeof payload.purpose !== "string" ||
    !CURSOR_COMPONENT.test(payload.purpose) ||
    typeof payload.sort !== "string" ||
    (!payload.order.toString().endsWith("created-desc") &&
      (!payload.sort || Buffer.byteLength(payload.sort, "utf8") > 300)) ||
    (payload.order.toString().endsWith("created-desc") &&
      new Date(payload.sort).toISOString() !== payload.sort)
  )
    return invalidCursor();
  return {
    id: payload.id.toLowerCase(),
    order: payload.order,
    parentId: payload.parentId.toLowerCase(),
    purpose: payload.purpose,
    sort: payload.sort,
    workspaceId: payload.workspaceId.toLowerCase(),
  };
}

export function encodeLocationCursor(
  payload: LocationCursorPayload,
  secret: string,
): string {
  const normalized = validateCursorPayload({
    v: 1,
    p: "humans.location.cursor.v1",
    ...payload,
  });
  const body = Buffer.from(
    JSON.stringify({ v: 1, p: "humans.location.cursor.v1", ...normalized }),
    "utf8",
  ).toString("base64url");
  return `${body}.${digest(secret, "humans:location-cursor-signature:v1", [body])}`;
}

export function decodeLocationCursor(
  value: string,
  binding: {
    order: string;
    parentId: string;
    purpose: string;
    secret: string;
    workspaceId: string;
  },
): LocationCursorPayload {
  try {
    if (!/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u.test(value) || value.length > 2048)
      return invalidCursor();
    const [body = "", signature = ""] = value.split(".");
    const expected = digest(
      binding.secret,
      "humans:location-cursor-signature:v1",
      [body],
    );
    if (
      !timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex"),
      )
    )
      return invalidCursor();
    const bytes = Buffer.from(body, "base64url");
    if (bytes.toString("base64url") !== body || bytes.byteLength > 1024)
      return invalidCursor();
    const payload = validateCursorPayload(JSON.parse(bytes.toString("utf8")));
    if (
      payload.workspaceId !== binding.workspaceId.toLowerCase() ||
      payload.parentId !== binding.parentId.toLowerCase() ||
      payload.order !== binding.order ||
      payload.purpose !== binding.purpose
    )
      return invalidCursor();
    return payload;
  } catch (error) {
    if (error instanceof TypeError && error.message === CURSOR_ERROR)
      throw error;
    return invalidCursor();
  }
}
