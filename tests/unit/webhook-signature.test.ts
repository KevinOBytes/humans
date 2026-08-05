import { describe, expect, it } from "vitest";

import {
  webhookEventHeaders,
  webhookRetryDelayMs,
  webhookSignature,
  verifyWebhookSignature,
} from "@/modules/webhooks/signature";

const secret = "whsec_" + "a".repeat(48);
const payload = JSON.stringify({ event: "webhook.test", value: "safe" });

describe("webhook signing contract", () => {
  it("signs the timestamp and exact payload and rejects tampering/replay", () => {
    const signature = webhookSignature({
      payload,
      secret,
      timestampSeconds: 1_700_000_000,
    });
    expect(
      verifyWebhookSignature({
        payload,
        secret,
        signature,
        timestampSeconds: 1_700_000_000,
        nowSeconds: 1_700_000_100,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        payload: `${payload} `,
        secret,
        signature,
        timestampSeconds: 1_700_000_000,
        nowSeconds: 1_700_000_100,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        payload,
        secret,
        signature,
        timestampSeconds: 1_700_000_000,
        nowSeconds: 1_700_000_301,
      }),
    ).toBe(false);
  });

  it("emits stable delivery headers and bounded exponential retry", () => {
    const headers = webhookEventHeaders({
      event: "webhook.test",
      deliveryId: "018f7a7f-6f6a-7c1b-8f1b-7d8d7984f8ab",
      payload,
      secret,
      timestampSeconds: 1_700_000_000,
    });
    expect(headers["x-humans-event"]).toBe("webhook.test");
    expect(headers["x-humans-signature"]).toMatch(/^v1=[0-9a-f]{64}$/u);
    expect(webhookRetryDelayMs(1)).toBe(1_250);
    expect(webhookRetryDelayMs(8)).toBeNull();
  });
});
