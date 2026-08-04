import { describe, expect, it, vi } from "vitest";

import {
  AiProviderError,
  createAiProvider,
  type AiProviderRuntime,
  type AiTransport,
} from "@/modules/ai/provider";

const fingerprintHmacKey = "8a".repeat(32);

function response(body: unknown, status = 200) {
  return {
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  };
}

function runtime(override: Partial<AiProviderRuntime> = {}): AiProviderRuntime {
  return {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-provider-key-value",
    model: "test-model",
    fingerprintHmacKey,
    transport: vi.fn(async () =>
      response({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Answer", role: "assistant" },
          },
        ],
      }),
    ),
    ...override,
  };
}

const input = {
  messages: [{ role: "user" as const, content: "Who is connected?" }],
  tools: [],
  toolLoopDepth: 0,
};

describe("AI provider boundary", () => {
  it("rejects providers outside the closed selection", () => {
    expect(() =>
      createAiProvider(runtime({ provider: "unknown" as "openai" })),
    ).toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));
  });

  it.each([
    ["openai", "https://api.openai.com/v1", "OPENAI"],
    ["ollama", "http://ollama:11434/v1/", "OLLAMA"],
    ["compatible", "https://AI.EXAMPLE.COM:443/v1/", "COMPATIBLE"],
  ] as const)(
    "selects and canonicalizes %s",
    (provider, baseUrl, disclosure) => {
      const created = createAiProvider(
        runtime({
          provider,
          baseUrl,
          apiKey: provider === "ollama" ? undefined : "test-provider-key-value",
          resolver:
            provider === "compatible"
              ? async () => [{ address: "203.0.113.10", family: 4 }]
              : undefined,
        }),
      );

      expect(created.disclosure).toEqual({
        model: "test-model",
        provider: disclosure,
      });
      expect(created.baseUrlFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(created)).not.toContain(baseUrl);
    },
  );

  it("requires keys for OpenAI and compatible providers", () => {
    expect(() => createAiProvider(runtime({ apiKey: undefined }))).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_INVALID" }),
    );
    expect(() =>
      createAiProvider(
        runtime({
          provider: "compatible",
          baseUrl: "https://ai.example.com/v1",
          apiKey: undefined,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));
  });

  it.each([
    "http://api.openai.com/v1",
    "https://other.example.com/v1",
    "https://api.openai.com/v1?key=value",
  ])("rejects a non-canonical OpenAI endpoint: %s", (baseUrl) => {
    expect(() => createAiProvider(runtime({ baseUrl }))).toThrow(
      AiProviderError,
    );
  });

  it.each([
    "http://ai.example.com/v1",
    "https://user:pass@ai.example.com/v1",
    "https://ai.example.com/v1?secret=value",
    "https://ai.example.com/v1#fragment",
    "https://ai.example.com/other",
  ])("rejects an unsafe compatible endpoint: %s", (baseUrl) => {
    expect(() =>
      createAiProvider(runtime({ provider: "compatible", baseUrl })),
    ).toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));
  });

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "169.254.169.254",
    "172.16.1.2",
    "192.168.1.2",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "::ffff:7f00:1",
  ])("rejects compatible endpoint address %s", async (address) => {
    const provider = createAiProvider(
      runtime({
        provider: "compatible",
        baseUrl: "https://ai.example.com/v1",
        resolver: async () => [address],
      }),
    );

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: "CONFIGURATION_INVALID",
    });
  });

  it("revalidates DNS for every compatible request and pins the chosen address", async () => {
    const resolver = vi.fn(async () => [
      { address: "203.0.113.10", family: 4 as const },
    ]);
    const transport = vi.fn<AiTransport>(async () =>
      response({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Answer", role: "assistant" },
          },
        ],
      }),
    );
    const provider = createAiProvider(
      runtime({
        provider: "compatible",
        baseUrl: "https://ai.example.com/v1",
        resolver,
        transport,
      }),
    );

    await provider.generate(input);
    await provider.generate(input);

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      address: "203.0.113.10",
      hostname: "ai.example.com",
      rejectRedirects: true,
    });
  });

  it("rejects redirects without following them", async () => {
    const transport = vi.fn<AiTransport>(async () => response("moved", 302));
    const provider = createAiProvider(runtime({ transport }));

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: "PROVIDER_REDIRECTED",
      message: "The AI provider request was rejected.",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("aborts a timed-out transport", async () => {
    let signal: AbortSignal | undefined;
    const transport = vi.fn<AiTransport>(
      (request) =>
        new Promise((_resolve, reject) => {
          signal = request.signal;
          request.signal.addEventListener("abort", () =>
            reject(new Error("raw timeout")),
          );
        }),
    );
    const provider = createAiProvider(runtime({ transport, timeoutMs: 5 }));

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      message: "The AI provider timed out.",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("maps caller aborts to a stable error", async () => {
    const controller = new AbortController();
    const transport = vi.fn<AiTransport>(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new Error("secret abort")),
          );
        }),
    );
    const provider = createAiProvider(runtime({ transport }));
    const pending = provider.generate({ ...input, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "PROVIDER_ABORTED",
      message: "The AI provider request was cancelled.",
    });
  });

  it("does not retain raw upstream errors", async () => {
    const apiKey = "test-provider-key-value";
    const prompt = "Who is connected?";
    const url = "https://api.openai.com/v1/chat/completions";
    const transport = vi.fn<AiTransport>(async () => {
      throw new Error(
        `${apiKey} ${prompt} ${url} Authorization: Bearer secret`,
      );
    });
    const provider = createAiProvider(runtime({ apiKey, transport }));

    let thrown: unknown;
    try {
      await provider.generate(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "The AI provider is unavailable.",
    });
    const serialized = JSON.stringify(thrown);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain(url);
    expect(serialized).not.toContain("Authorization");
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("parses bounded final answers with candidate citations", async () => {
    const transport = vi.fn<AiTransport>(async () =>
      response({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                answer: "Alice is connected to Bob.",
                citations: [
                  { resourceId: "018f0d90-1111-7111-8111-111111111111" },
                ],
              }),
            },
          },
        ],
      }),
    );
    const provider = createAiProvider(runtime({ transport }));

    await expect(provider.generate(input)).resolves.toEqual({
      type: "answer",
      answer: "Alice is connected to Bob.",
      citations: [{ resourceId: "018f0d90-1111-7111-8111-111111111111" }],
    });
  });

  it("rejects malformed structured answers instead of treating JSON as text", async () => {
    const transport = vi.fn<AiTransport>(async () =>
      response({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                answer: "Unbounded candidate",
                citations: [{ resourceId: "not-a-uuid" }],
              }),
            },
          },
        ],
      }),
    );
    const provider = createAiProvider(runtime({ transport }));

    await expect(provider.generate(input)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
    });
  });

  it("parses typed tool calls and rejects excessive loop depth", async () => {
    const transport = vi.fn<AiTransport>(async () =>
      response({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "getPerson",
                    arguments:
                      '{"personId":"018f0d90-1111-7111-8111-111111111111"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createAiProvider(runtime({ transport }));

    await expect(provider.generate(input)).resolves.toMatchObject({
      type: "tool_calls",
      toolCalls: [{ id: "call_1", name: "getPerson" }],
    });
    await expect(
      provider.generate({ ...input, toolLoopDepth: 4 }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("round-trips assistant tool calls into the next provider turn", async () => {
    const transport = vi.fn<AiTransport>(async () =>
      response({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Done" },
          },
        ],
      }),
    );
    const provider = createAiProvider(runtime({ transport }));

    await provider.generate({
      messages: [
        { role: "user", content: "Find Alice" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "getPerson",
              arguments: { personId: "018f0d90-1111-7111-8111-111111111111" },
            },
          ],
        },
        {
          role: "tool",
          content: '{"ok":true}',
          name: "getPerson",
          toolCallId: "call_1",
        },
      ],
      tools: [],
      toolLoopDepth: 1,
    });

    const body = JSON.parse(transport.mock.calls[0]![0].body) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "getPerson",
            arguments: '{"personId":"018f0d90-1111-7111-8111-111111111111"}',
          },
        },
      ],
    });
  });
});
