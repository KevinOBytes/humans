import type { ServerEnv } from "@/lib/env/server-schema";

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface EmailMessage {
  to: string | readonly string[];
  subject: string;
  text?: string;
  html?: string;
}

export interface EmailSender {
  send(
    message: EmailMessage,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<{ id: string }>;
}

type Fetch = typeof fetch;

function emailsEndpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid email provider endpoint");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/emails`;
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Email provider response exceeded limit");
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Email provider response exceeded limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export class ResendEmailSender implements EmailSender {
  private readonly endpoint: URL;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    baseUrl = "https://api.resend.com",
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.endpoint = emailsEndpoint(baseUrl);
  }

  async send(
    message: EmailMessage,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<{ id: string }> {
    if (!message.text && !message.html) {
      throw new TypeError("Email messages require text or HTML content");
    }
    const headers = new Headers({
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    });
    if (options?.idempotencyKey) {
      headers.set("idempotency-key", options.idempotencyKey);
    }
    try {
      const response = await this.fetchImpl(this.endpoint, {
        body: JSON.stringify({
          from: this.from,
          to:
            typeof message.to === "string"
              ? message.to
              : Array.from(message.to),
          subject: message.subject,
          ...(message.html ? { html: message.html } : {}),
          ...(message.text ? { text: message.text } : {}),
        }),
        headers,
        method: "POST",
        signal: options?.signal,
      });
      const result = await boundedJson(response);
      const id =
        result && typeof result === "object"
          ? (result as { id?: unknown }).id
          : undefined;
      if (!response.ok || typeof id !== "string" || id.length === 0) {
        throw new Error("Invalid email provider response");
      }
      return { id };
    } catch {
      throw new Error("Email delivery failed");
    }
  }
}

export function createEmailSender(env: ServerEnv): EmailSender {
  return new ResendEmailSender(
    env.RESEND_API_KEY,
    env.EMAIL_FROM,
    env.RESEND_BASE_URL,
  );
}
