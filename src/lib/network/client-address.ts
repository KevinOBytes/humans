import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

export type ClientAddressClassification =
  | Readonly<{
      family: 4 | 6;
      prefix: string;
      source: "vercel" | "hmac_proxy";
      trust: "trusted";
    }>
  | Readonly<{
      reason: "disabled" | "missing" | "malformed" | "unauthenticated";
      trust: "unknown";
    }>;

export type TrustedProxyConfig =
  | Readonly<{ deploymentMode: "docker" | "vercel"; mode: "none" }>
  | Readonly<{ deploymentMode: "vercel"; mode: "vercel" }>
  | Readonly<{
      deploymentMode: "docker";
      hmacKey: string;
      mode: "hmac";
    }>;

type ParsedAddress = Readonly<{
  canonical: string;
  family: 4 | 6;
  prefix: string;
}>;

const HMAC_KEY = /^[0-9a-f]{64}$/iu;
const SIGNATURE = /^[0-9a-f]{64}$/u;
const MAX_HEADER_BYTES = 128;

function unknown(
  reason: Extract<ClientAddressClassification, { trust: "unknown" }>["reason"],
): ClientAddressClassification {
  return Object.freeze({ reason, trust: "unknown" });
}

function ipv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function canonicalIpv6(words: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = words.map((word) => word.toString(16));
  if (bestStart < 0) return hex.join(":");
  const before = hex.slice(0, bestStart).join(":");
  const after = hex.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}

function ipv6(value: string): readonly number[] | null {
  let expanded = value;
  if (expanded.includes(".")) {
    const lastColon = expanded.lastIndexOf(":");
    if (lastColon < 0) return null;
    const tail = ipv4(expanded.slice(lastColon + 1));
    if (!tail) return null;
    expanded = `${expanded.slice(0, lastColon)}:${((tail[0]! << 8) | tail[1]!).toString(16)}:${((tail[2]! << 8) | tail[3]!).toString(16)}`;
  }
  const halves = expanded.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function parseAddress(value: string): ParsedAddress | null {
  if (
    value !== value.trim() ||
    !value ||
    value.includes(",") ||
    value.includes("%") ||
    Buffer.byteLength(value, "utf8") > MAX_HEADER_BYTES
  ) {
    return null;
  }
  const v4 = ipv4(value);
  if (v4) {
    return Object.freeze({
      canonical: v4.join("."),
      family: 4,
      prefix: `${v4[0]}.${v4[1]}.${v4[2]}.0/24`,
    });
  }
  const words = ipv6(value);
  if (!words) return null;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mapped = [
      words[6]! >> 8,
      words[6]! & 0xff,
      words[7]! >> 8,
      words[7]! & 0xff,
    ];
    return Object.freeze({
      canonical: mapped.join("."),
      family: 4,
      prefix: `${mapped[0]}.${mapped[1]}.${mapped[2]}.0/24`,
    });
  }
  const canonical = canonicalIpv6(words);
  return Object.freeze({
    canonical,
    family: 6,
    prefix: `${canonicalIpv6([...words.slice(0, 4), 0, 0, 0, 0])}/64`,
  });
}

export function isCanonicalClientPrefix(value: string): boolean {
  const suffix = value.endsWith("/24")
    ? "/24"
    : value.endsWith("/64")
      ? "/64"
      : null;
  if (!suffix) return false;
  const parsed = parseAddress(value.slice(0, -suffix.length));
  return parsed?.prefix === value;
}

export function classifyClientAddress(
  request: Request,
  config: TrustedProxyConfig,
): ClientAddressClassification {
  if (config.mode === "none") return unknown("disabled");
  if (config.mode === "vercel") {
    if (config.deploymentMode !== "vercel") return unknown("unauthenticated");
    const value = request.headers.get("x-vercel-forwarded-for");
    if (value === null) return unknown("missing");
    const parsed = parseAddress(value);
    return parsed
      ? Object.freeze({
          family: parsed.family,
          prefix: parsed.prefix,
          source: "vercel",
          trust: "trusted",
        })
      : unknown("malformed");
  }
  if (config.deploymentMode !== "docker") return unknown("unauthenticated");
  const address = request.headers.get("x-humans-client-address");
  const suppliedSignature = request.headers.get(
    "x-humans-client-address-signature",
  );
  if (address === null || suppliedSignature === null) return unknown("missing");
  const parsed = parseAddress(address);
  if (!parsed) return unknown("malformed");
  if (
    Buffer.byteLength(suppliedSignature, "utf8") > MAX_HEADER_BYTES ||
    !HMAC_KEY.test(config.hmacKey) ||
    !SIGNATURE.test(suppliedSignature)
  ) {
    return unknown("unauthenticated");
  }
  const expected = createHmac("sha256", Buffer.from(config.hmacKey, "hex"))
    .update("humans:trusted-client-address:v1\0", "utf8")
    .update(parsed.canonical, "utf8")
    .digest();
  const actual = Buffer.from(suppliedSignature, "hex");
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    return unknown("unauthenticated");
  }
  return Object.freeze({
    family: parsed.family,
    prefix: parsed.prefix,
    source: "hmac_proxy",
    trust: "trusted",
  });
}
