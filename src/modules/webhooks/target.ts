import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PublicWebhookTarget = Readonly<{
  address: string;
  family: 4 | 6;
  hostname: string;
  url: URL;
}>;

function privateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)))
    return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  if (mappedIpv4?.[1]) return privateIpv4(mappedIpv4[1]);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

export function isPrivateAddress(value: string): boolean {
  const kind = isIP(value);
  return kind === 4
    ? privateIpv4(value)
    : kind === 6
      ? privateIpv6(value)
      : true;
}

/** Resolve and retain the public address that the delivery transport must use. */
export async function resolvePublicWebhookTarget(
  urlValue: string,
): Promise<PublicWebhookTarget> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") throw new Error("webhook_target_protocol");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error("webhook_target_private");
  }
  const selected = addresses[0]!;
  return {
    address: selected.address,
    family: selected.family as 4 | 6,
    hostname: url.hostname,
    url,
  };
}

/** Compatibility validator for callers that do not initiate a connection. */
export async function assertPublicWebhookTarget(
  urlValue: string,
): Promise<void> {
  await resolvePublicWebhookTarget(urlValue);
}
