// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { ResendEmailSender } from "@/lib/email/resend";

describe("Resend email sender", () => {
  it("uses the official request shape and forwards cancellation and idempotency", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(
      Response.json({ id: "provider-id" }, { status: 200 }),
    );
    const sender = new ResendEmailSender(
      "provider-api-key",
      "Humans <humans@example.test>",
      "https://api.resend.test/v1/",
      fetchImpl,
    );
    const controller = new AbortController();

    await expect(
      sender.send(
        {
          to: "person@example.test",
          subject: "Verify",
          text: "Safe body",
        },
        {
          idempotencyKey: "auth-verification-safe-key",
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual({ id: "provider-id" });
    const [url, init = {}] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.resend.test/v1/emails");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-api-key");
    expect(headers.get("idempotency-key")).toBe("auth-verification-safe-key");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Humans <humans@example.test>",
      subject: "Verify",
      text: "Safe body",
      to: "person@example.test",
    });
  });

  it("bounds response parsing and exposes only generic provider failures", async () => {
    const oversized = new Uint8Array(65 * 1024);
    const sender = new ResendEmailSender(
      "provider-api-key",
      "Humans <humans@example.test>",
      "https://api.resend.test",
      async () => new Response(oversized, { status: 500 }),
    );

    await expect(
      sender.send({
        to: "person@example.test",
        subject: "Verify",
        text: "Safe body",
      }),
    ).rejects.toThrow(/^Email delivery failed$/u);
  });

  it("settles when the underlying fetch observes abort", async () => {
    let active = 0;
    let observedAbort = false;
    const sender = new ResendEmailSender(
      "provider-api-key",
      "Humans <humans@example.test>",
      "https://api.resend.test",
      (_url, init) => {
        active += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              active -= 1;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      },
    );
    const controller = new AbortController();
    const sending = sender.send(
      {
        to: "person@example.test",
        subject: "Verify",
        text: "Safe body",
      },
      { signal: controller.signal },
    );
    expect(active).toBe(1);
    controller.abort();

    await expect(sending).rejects.toThrow(/^Email delivery failed$/u);
    expect(observedAbort).toBe(true);
    expect(active).toBe(0);
  });
});
