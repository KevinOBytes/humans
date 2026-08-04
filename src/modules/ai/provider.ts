import "server-only";

import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { z } from "zod";

import {
  canonicalizeAiBaseUrl,
  isPublicProviderAddress,
  type AiProvider,
  type AiProviderGenerateInput,
  type AiProviderName,
  type AiProviderTurn,
} from "./types";

export type {
  AiCandidateCitation,
  AiProvider,
  AiProviderDisclosure,
  AiProviderGenerateInput,
  AiProviderMessage,
  AiProviderToolCall,
  AiProviderTurn,
  AiToolDeclaration,
} from "./types";

const MAX_MESSAGES = 48;
const MAX_MESSAGE_BYTES = 32_768;
const MAX_REQUEST_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_LOOP_DEPTH = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AiProviderErrorCode =
  | "CAPABILITY_UNSUPPORTED"
  | "CONFIGURATION_INVALID"
  | "PROVIDER_ABORTED"
  | "PROVIDER_REDIRECTED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "REQUEST_INVALID";

const ERROR_MESSAGES: Readonly<Record<AiProviderErrorCode, string>> = {
  CAPABILITY_UNSUPPORTED: "The AI provider capability is unsupported.",
  CONFIGURATION_INVALID: "The AI provider configuration is invalid.",
  PROVIDER_ABORTED: "The AI provider request was cancelled.",
  PROVIDER_REDIRECTED: "The AI provider request was rejected.",
  PROVIDER_RESPONSE_INVALID: "The AI provider returned an invalid response.",
  PROVIDER_RESPONSE_TOO_LARGE: "The AI provider response exceeded its limit.",
  PROVIDER_TIMEOUT: "The AI provider timed out.",
  PROVIDER_UNAVAILABLE: "The AI provider is unavailable.",
  REQUEST_INVALID: "The AI provider request is invalid.",
};

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;

  constructor(code: AiProviderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AiProviderError";
    this.code = code;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export type AiResolvedAddress = Readonly<{
  address: string;
  family?: 4 | 6;
}>;

export type AiDnsResolver = (
  hostname: string,
) => Promise<readonly (string | AiResolvedAddress)[]>;

export type AiTransportRequest = Readonly<{
  url: URL;
  hostname: string;
  address?: string;
  family?: 4 | 6;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
  maxResponseBytes: number;
  rejectRedirects: true;
}>;

export type AiTransportResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: string | Uint8Array;
}>;

export type AiTransport = (
  request: AiTransportRequest,
) => Promise<AiTransportResponse>;

export type AiProviderRuntime = Readonly<{
  provider: AiProviderName;
  baseUrl: string;
  apiKey?: string;
  model: string;
  fingerprintHmacKey: string;
  nodeEnv?: "development" | "test" | "production";
  resolver?: AiDnsResolver;
  transport?: AiTransport;
  timeoutMs?: number;
}>;

const citationSchema = z
  .object({
    resourceId: z.string().regex(UUID_PATTERN),
    evidenceId: z.string().regex(UUID_PATTERN).optional(),
    excerpt: z.string().max(1_000).optional(),
  })
  .strict();
const finalAnswerSchema = z
  .object({
    answer: z.string().min(1).max(64_000),
    citations: z.array(citationSchema).max(20).default([]),
  })
  .strict();
const toolCallSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
        arguments: z.string().max(32_768),
      })
      .strict(),
  })
  .strict();
const responseSchema = z
  .object({
    choices: z
      .array(
        z.object({
          finish_reason: z.string().nullable().optional(),
          message: z.object({
            role: z.literal("assistant"),
            content: z.string().nullable().optional(),
            tool_calls: z.array(toolCallSchema).max(MAX_TOOL_CALLS).optional(),
          }),
        }),
      )
      .length(1),
  })
  .strip();

function providerError(code: AiProviderErrorCode): AiProviderError {
  return new AiProviderError(code);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeAddress(
  value: string | AiResolvedAddress,
): AiResolvedAddress {
  return typeof value === "string" ? { address: value } : value;
}

async function defaultResolver(
  hostname: string,
): Promise<readonly AiResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses
    .filter((entry) => entry.family === 4 || entry.family === 6)
    .map((entry) => ({
      address: entry.address,
      family: entry.family as 4 | 6,
    }));
}

const defaultTransport: AiTransport = async (input) =>
  new Promise((resolve, reject) => {
    const client = input.url.protocol === "https:" ? https : http;
    const request = client.request(
      {
        protocol: input.url.protocol,
        hostname: input.address ?? input.hostname,
        port: input.url.port || undefined,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: input.headers,
        signal: input.signal,
        agent: false,
        ...(input.url.protocol === "https:"
          ? { servername: input.hostname, rejectUnauthorized: true }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > input.maxResponseBytes) {
            request.destroy(providerError("PROVIDER_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          const headers = Object.fromEntries(
            Object.entries(response.headers).map(([key, value]) => [
              key,
              value,
            ]),
          );
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(input.body);
  });

function validateRuntime(runtime: AiProviderRuntime): {
  canonicalBaseUrl: string;
  timeoutMs: number;
} {
  if (
    !(["openai", "ollama", "compatible"] as const).includes(runtime.provider)
  ) {
    throw providerError("CONFIGURATION_INVALID");
  }
  if (!runtime.model.trim() || runtime.model.length > 200) {
    throw providerError("CONFIGURATION_INVALID");
  }
  if (
    (runtime.provider === "openai" || runtime.provider === "compatible") &&
    !runtime.apiKey
  ) {
    throw providerError("CONFIGURATION_INVALID");
  }
  if (!/^[0-9a-f]{64}$/iu.test(runtime.fingerprintHmacKey)) {
    throw providerError("CONFIGURATION_INVALID");
  }
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw providerError("CONFIGURATION_INVALID");
  }
  try {
    return {
      canonicalBaseUrl: canonicalizeAiBaseUrl({
        provider: runtime.provider,
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        nodeEnv:
          runtime.nodeEnv ??
          (process.env.NODE_ENV === "production" ||
          process.env.NODE_ENV === "test"
            ? process.env.NODE_ENV
            : "development"),
      }),
      timeoutMs,
    };
  } catch {
    throw providerError("CONFIGURATION_INVALID");
  }
}

function requestBody(input: AiProviderGenerateInput, model: string): string {
  if (
    !Number.isInteger(input.toolLoopDepth) ||
    input.toolLoopDepth < 0 ||
    input.toolLoopDepth >= MAX_TOOL_LOOP_DEPTH
  ) {
    throw providerError("CAPABILITY_UNSUPPORTED");
  }
  if (!input.messages.length || input.messages.length > MAX_MESSAGES) {
    throw providerError("REQUEST_INVALID");
  }
  const messages = input.messages.map((message) => {
    const hasToolCalls = Boolean(message.toolCalls?.length);
    if (
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      (!message.content && !(message.role === "assistant" && hasToolCalls)) ||
      byteLength(message.content) > MAX_MESSAGE_BYTES ||
      (message.role === "tool" && !message.toolCallId) ||
      (message.role !== "tool" && message.toolCallId !== undefined) ||
      (message.role !== "assistant" && message.toolCalls !== undefined) ||
      (message.toolCalls !== undefined &&
        (message.toolCalls.length < 1 ||
          message.toolCalls.length > MAX_TOOL_CALLS)) ||
      (message.name !== undefined &&
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(message.name))
    ) {
      throw providerError("REQUEST_INVALID");
    }
    const toolCalls = message.toolCalls?.map((call) => {
      if (
        !call.id ||
        call.id.length > 200 ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(call.name) ||
        !call.arguments ||
        typeof call.arguments !== "object" ||
        Array.isArray(call.arguments)
      ) {
        throw providerError("REQUEST_INVALID");
      }
      let argumentsJson: string;
      try {
        argumentsJson = JSON.stringify(call.arguments);
      } catch {
        throw providerError("REQUEST_INVALID");
      }
      if (byteLength(argumentsJson) > MAX_MESSAGE_BYTES)
        throw providerError("REQUEST_INVALID");
      return {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: argumentsJson },
      };
    });
    return {
      role: message.role,
      content: hasToolCalls ? null : message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
  });
  if (input.tools.length > 8) throw providerError("CAPABILITY_UNSUPPORTED");
  const tools = input.tools.map((tool) => {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(tool.name) ||
      !tool.description ||
      tool.description.length > 1_000 ||
      !tool.parameters ||
      Array.isArray(tool.parameters) ||
      typeof tool.parameters !== "object"
    ) {
      throw providerError("REQUEST_INVALID");
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
  let body: string;
  try {
    body = JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: tools.length ? "auto" : undefined,
    });
  } catch {
    throw providerError("REQUEST_INVALID");
  }
  if (byteLength(body) > MAX_REQUEST_BYTES)
    throw providerError("REQUEST_INVALID");
  return body;
}

function parseTurn(body: string): AiProviderTurn {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw providerError("PROVIDER_RESPONSE_INVALID");
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw providerError("PROVIDER_RESPONSE_INVALID");
  const message = parsed.data.choices[0]!.message;
  if (message.tool_calls?.length) {
    const toolCalls = message.tool_calls.map((call) => {
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        throw providerError("PROVIDER_RESPONSE_INVALID");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw providerError("PROVIDER_RESPONSE_INVALID");
      }
      return {
        id: call.id,
        name: call.function.name,
        arguments: Object.freeze({ ...(args as Record<string, unknown>) }),
      };
    });
    return Object.freeze({
      type: "tool_calls",
      toolCalls: Object.freeze(toolCalls),
    });
  }
  if (!message.content) throw providerError("PROVIDER_RESPONSE_INVALID");
  let structuredCandidate: unknown;
  try {
    structuredCandidate = JSON.parse(message.content);
  } catch {
    structuredCandidate = undefined;
  }
  if (structuredCandidate !== undefined) {
    const structured = finalAnswerSchema.safeParse(structuredCandidate);
    if (!structured.success) throw providerError("PROVIDER_RESPONSE_INVALID");
    return Object.freeze({
      type: "answer",
      answer: structured.data.answer,
      citations: Object.freeze(structured.data.citations),
    });
  }
  if (message.content.length > 64_000)
    throw providerError("PROVIDER_RESPONSE_INVALID");
  return Object.freeze({
    type: "answer",
    answer: message.content,
    citations: Object.freeze([]),
  });
}

export function createAiProvider(runtime: AiProviderRuntime): AiProvider {
  const { canonicalBaseUrl, timeoutMs } = validateRuntime(runtime);
  const disclosure = Object.freeze({
    model: runtime.model,
    provider: runtime.provider.toUpperCase() as
      "OPENAI" | "OLLAMA" | "COMPATIBLE",
  });
  const baseUrlFingerprint = createHmac(
    "sha256",
    Buffer.from(runtime.fingerprintHmacKey, "hex"),
  )
    .update("humans:ai-provider-base-url:v1\0", "utf8")
    .update(canonicalBaseUrl, "utf8")
    .digest("hex");
  const endpoint = new URL(`${canonicalBaseUrl}/chat/completions`);
  const transport = runtime.transport ?? defaultTransport;
  const resolver = runtime.resolver ?? defaultResolver;

  return Object.freeze({
    disclosure,
    baseUrlFingerprint,
    async generate(input: AiProviderGenerateInput): Promise<AiProviderTurn> {
      if (input.signal?.aborted) throw providerError("PROVIDER_ABORTED");
      const body = requestBody(input, runtime.model);
      const controller = new AbortController();
      let timedOut = false;
      let callerAborted = false;
      const abortFromCaller = () => {
        callerAborted = true;
        controller.abort();
      };
      input.signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (input.signal?.aborted) abortFromCaller();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(providerError("PROVIDER_ABORTED")),
          {
            once: true,
          },
        );
      });
      try {
        let address: AiResolvedAddress | undefined;
        if (runtime.provider === "compatible") {
          const resolved = await Promise.race([
            resolver(endpoint.hostname),
            abortPromise,
          ]);
          if (input.signal?.aborted) abortFromCaller();
          if (controller.signal.aborted)
            throw providerError("PROVIDER_ABORTED");
          const addresses = resolved.map(normalizeAddress);
          if (
            !addresses.length ||
            addresses.some(({ address }) => !isPublicProviderAddress(address))
          ) {
            throw providerError("CONFIGURATION_INVALID");
          }
          address = addresses[0];
        }

        const response = await Promise.race([
          transport({
            url: new URL(endpoint.href),
            hostname: endpoint.hostname,
            address: address?.address,
            family: address?.family,
            method: "POST",
            headers: Object.freeze({
              accept: "application/json",
              "content-type": "application/json",
              ...(runtime.apiKey
                ? { authorization: `Bearer ${runtime.apiKey}` }
                : {}),
              host: endpoint.host,
            }),
            body,
            signal: controller.signal,
            maxResponseBytes: MAX_RESPONSE_BYTES,
            rejectRedirects: true,
          }),
          abortPromise,
        ]);
        if (response.status >= 300 && response.status < 400) {
          throw providerError("PROVIDER_REDIRECTED");
        }
        if (response.status < 200 || response.status >= 300) {
          throw providerError("PROVIDER_UNAVAILABLE");
        }
        const responseBody =
          typeof response.body === "string"
            ? response.body
            : Buffer.from(response.body).toString("utf8");
        if (byteLength(responseBody) > MAX_RESPONSE_BYTES) {
          throw providerError("PROVIDER_RESPONSE_TOO_LARGE");
        }
        return parseTurn(responseBody);
      } catch (error) {
        if (timedOut) throw providerError("PROVIDER_TIMEOUT");
        if (callerAborted || input.signal?.aborted)
          throw providerError("PROVIDER_ABORTED");
        if (error instanceof AiProviderError) throw error;
        throw providerError("PROVIDER_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  });
}
