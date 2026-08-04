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

/** True only for addresses suitable for an Internet-facing compatible provider. */
export function isPublicProviderAddress(rawAddress: string): boolean {
  const address = stripIpv6Brackets(rawAddress).toLowerCase();
  const version = isIP(address);
  if (version === 0) return false;
  if (version === 4) {
    const bytes = ipv4Bytes(address)!;
    const [a, b] = bytes;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const normalized = address;
  if (normalized === "::" || normalized === "::1") return false;
  if (/^f[cd][0-9a-f]{2}:/u.test(normalized)) return false;
  if (/^fe[89ab][0-9a-f]:/u.test(normalized)) return false;
  if (/^ff[0-9a-f]{2}:/u.test(normalized)) return false;
  const mapped = normalized.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/u);
  if (mapped) return isPublicProviderAddress(mapped[1]!);
  const mappedHex = normalized.match(
    /^(?:(?:0{1,4}:){5}|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u,
  );
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return isPublicProviderAddress(
      `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
    );
  }
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
