import { isIP } from "node:net";

export const AI_PROVIDER_NAMES = ["openai", "ollama", "compatible"] as const;
export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

export type AiProviderDisclosure = Readonly<{
  model: string;
  provider: "OPENAI" | "OLLAMA" | "COMPATIBLE";
}>;

export type AiCandidateCitation = Readonly<{
  resourceId: string;
  evidenceId?: string;
  excerpt?: string;
}>;

export type AiProviderToolCall = Readonly<{
  id: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}>;

export type AiProviderTurn =
  | Readonly<{
      type: "answer";
      answer: string;
      citations: readonly AiCandidateCitation[];
    }>
  | Readonly<{
      type: "tool_calls";
      toolCalls: readonly AiProviderToolCall[];
    }>;

export type AiProviderMessage = Readonly<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly AiProviderToolCall[];
}>;

export type AiToolDeclaration = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type AiProviderGenerateInput = Readonly<{
  messages: readonly AiProviderMessage[];
  tools: readonly AiToolDeclaration[];
  toolLoopDepth: number;
  signal?: AbortSignal;
}>;

export type AiProvider = Readonly<{
  disclosure: AiProviderDisclosure;
  baseUrlFingerprint: string;
  generate(input: AiProviderGenerateInput): Promise<AiProviderTurn>;
}>;

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4Bytes(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const bytes = address.split(".").map(Number);
  return bytes.length === 4 ? bytes : null;
}

function ipv4Number(address: string): number | null {
  const bytes = ipv4Bytes(address);
  if (!bytes) return null;
  return (
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  );
}

function ipv4InCidr(
  address: number,
  network: string,
  prefixLength: number,
): boolean {
  const networkNumber = ipv4Number(network)!;
  const mask =
    prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) >>> 0 === (networkNumber & mask) >>> 0;
}

const NON_GLOBAL_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

function ipv6Words(address: string): readonly number[] | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  const dottedSuffix = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u);
  if (dottedSuffix) {
    const bytes = ipv4Bytes(dottedSuffix[1]!);
    if (!bytes) return null;
    normalized = normalized.replace(
      dottedSuffix[1]!,
      `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${(
        (bytes[2]! << 8) |
        bytes[3]!
      ).toString(16)}`,
    );
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 &&
    words.every((word) => word >= 0 && word <= 0xffff)
    ? words
    : null;
}

/** True only for addresses suitable for an Internet-facing compatible provider. */
export function isPublicProviderAddress(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress).toLowerCase();
  const version = isIP(address);
  if (version === 0) return false;
  if (version === 4) {
    const numeric = ipv4Number(address)!;
    return !NON_GLOBAL_IPV4_CIDRS.some(([network, prefixLength]) =>
      ipv4InCidr(numeric, network, prefixLength),
    );
  }

  const words = ipv6Words(address);
  if (!words) return false;
  const [first, second] = words;

  // Current global-unicast allocations are within 2000::/3. The exclusions
  // below are IANA special-purpose blocks inside that aggregate.
  if ((first! & 0xe000) !== 0x2000) return false;
  if (first === 0x2001 && second! < 0x0200) return false; // IETF protocol assignments
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x2002) return false; // deprecated 6to4
  if (first === 0x3fff && (second! & 0xf000) === 0) return false; // documentation
  return true;
}

export type CanonicalAiBaseUrlInput = Readonly<{
  provider: AiProviderName;
  baseUrl: string;
  apiKey?: string;
  nodeEnv: "development" | "test" | "production";
}>;

/**
 * Canonicalizes the only endpoint forms the provider boundary can connect to.
 * It deliberately does not resolve DNS; compatible DNS is checked immediately
 * before every request and the resulting address is pinned by the transport.
 */
export function canonicalizeAiBaseUrl(input: CanonicalAiBaseUrlInput): string {
  if (
    input.baseUrl !== input.baseUrl.trim() ||
    /[\u0000-\u001f\u007f]/u.test(input.baseUrl)
  ) {
    throw new TypeError("AI_BASE_URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new TypeError("AI_BASE_URL is invalid");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/v1" && url.pathname !== "/v1/")
  ) {
    throw new TypeError("AI_BASE_URL is invalid");
  }
  if (input.apiKey && url.protocol !== "https:") {
    throw new TypeError("AI_BASE_URL must use HTTPS when a key is configured");
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (input.provider === "openai") {
    if (
      url.protocol !== "https:" ||
      hostname !== "api.openai.com" ||
      (url.port && url.port !== "443")
    ) {
      throw new TypeError("AI_BASE_URL must use the canonical OpenAI endpoint");
    }
  } else if (input.provider === "compatible") {
    if (
      url.protocol !== "https:" ||
      (isIP(hostname) && !isPublicProviderAddress(hostname))
    ) {
      throw new TypeError("AI_BASE_URL must use a public HTTPS endpoint");
    }
  } else {
    const dockerService =
      url.protocol === "http:" && hostname === "ollama" && url.port === "11434";
    const testLoopback =
      input.nodeEnv === "test" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (!dockerService && !testLoopback) {
      throw new TypeError(
        "AI_BASE_URL must use the configured Ollama service or a loopback test endpoint",
      );
    }
  }

  url.pathname = "/v1";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/u, "");
}
