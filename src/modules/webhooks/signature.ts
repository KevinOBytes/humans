import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_ALGORITHM = "hmac-sha256" as const;
export const WEBHOOK_MAX_PAYLOAD_BYTES = 64 * 1024;

export function webhookPayloadHash(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function webhookSignature(input: {
  payload: string;
  secret: string;
  timestampSeconds: number;
}): string {
  if (
    !Number.isSafeInteger(input.timestampSeconds) ||
    input.timestampSeconds < 0 ||
    input.secret.length < 32
  ) {
    throw new TypeError("Invalid webhook signature input");
  }
  const material = `${input.timestampSeconds}.${input.payload}`;
  return `v1=${createHmac("sha256", input.secret).update(material, "utf8").digest("hex")}`;
}

export function verifyWebhookSignature(input: {
  payload: string;
  secret: string;
  signature: string;
  timestampSeconds: number;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(input.timestampSeconds) ||
    !Number.isSafeInteger(tolerance) ||
    tolerance < 1 ||
    Math.abs(now - input.timestampSeconds) > tolerance
  ) {
    return false;
  }
  let expected: string;
  try {
    expected = webhookSignature(input);
  } catch {
    return false;
  }
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(input.signature, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function webhookRetryDelayMs(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("Invalid webhook attempt");
  }
  if (attempt >= 8) return null;
  const base = Math.min(15 * 60_000, 1_000 * 2 ** (attempt - 1));
  return base + Math.floor(base * 0.25);
}

export function webhookEventHeaders(input: {
  event: string;
  deliveryId: string;
  payload: string;
  secret: string;
  timestampSeconds: number;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "Humans-Webhook/1",
    "x-humans-delivery": input.deliveryId,
    "x-humans-event": input.event,
    "x-humans-signature": webhookSignature(input),
    "x-humans-signature-timestamp": String(input.timestampSeconds),
  };
}
