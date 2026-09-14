import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ResendEmailSender } from "@/lib/email/resend";
import { createAiProvider } from "@/modules/ai/provider";
import type { AiProviderName } from "@/modules/ai/types";

const contractsEnabled = process.env.RUN_EXTERNAL_PROVIDER_CONTRACTS === "true";

const aiProvider = process.env.TEST_AI_PROVIDER as AiProviderName | undefined;
const aiBaseUrl = process.env.TEST_AI_BASE_URL;
const aiModel = process.env.TEST_AI_MODEL;
const aiApiKey = process.env.TEST_AI_API_KEY;
const aiConfigured =
  contractsEnabled &&
  Boolean(
    aiProvider && aiBaseUrl && aiModel && (aiProvider === "ollama" || aiApiKey),
  );

describe.runIf(aiConfigured)("AI provider lifecycle contract", () => {
  it("returns a structured answer through the configured production adapter", async () => {
    const provider = createAiProvider({
      provider: aiProvider!,
      baseUrl: aiBaseUrl!,
      apiKey: aiApiKey,
      model: aiModel!,
      fingerprintHmacKey: "4f".repeat(32),
      nodeEnv: "test",
      timeoutMs: 30_000,
    });

    const turn = await provider.generate({
      messages: [
        {
          role: "user",
          content:
            "Return a short confirmation that this provider contract is available, with no citations.",
        },
      ],
      tools: [],
      toolLoopDepth: 0,
    });

    expect(turn.type).toBe("answer");
    if (turn.type !== "answer") throw new Error("Expected an answer turn");
    expect(turn.answer.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(turn.citations)).toBe(true);
  }, 45_000);
});

const resendApiKey = process.env.TEST_RESEND_API_KEY;
const resendFrom = process.env.TEST_RESEND_FROM;
const resendRecipient = process.env.TEST_RESEND_RECIPIENT;
const resendConfigured =
  contractsEnabled && Boolean(resendApiKey && resendFrom && resendRecipient);

describe.runIf(resendConfigured)("Resend provider lifecycle contract", () => {
  it("accepts one idempotent attended acceptance message", async () => {
    const idempotencyKey = randomUUID();
    const sender = new ResendEmailSender(
      resendApiKey!,
      resendFrom!,
      process.env.TEST_RESEND_BASE_URL,
    );

    const result = await sender.send(
      {
        to: resendRecipient!,
        subject: "Humans provider acceptance",
        text: "This fictional message verifies the attended Humans Resend provider contract.",
      },
      { idempotencyKey, signal: AbortSignal.timeout(30_000) },
    );

    expect(result.id.length).toBeGreaterThan(0);
  }, 45_000);
});
