// @vitest-environment node

import { describe, expect, it } from "vitest";

import { mapAiFailureCode } from "@/modules/ai/repository-domain";

describe("AI persistence failure mapping", () => {
  it.each([
    ["PROVIDER_TIMEOUT", "provider_timeout"],
    ["PROVIDER_UNAVAILABLE", "provider_unavailable"],
    ["PROVIDER_RESPONSE_INVALID", "provider_invalid_response"],
    ["PROVIDER_REDIRECTED", "provider_invalid_response"],
    ["PROVIDER_RESPONSE_TOO_LARGE", "provider_response_too_large"],
    ["PROVIDER_ABORTED", "analysis_cancelled"],
    ["CAPABILITY_UNSUPPORTED", "analysis_limit_reached"],
    ["AUTHORIZATION_CHANGED", "authorization_changed"],
    ["INPUT_UNAVAILABLE", "input_unavailable"],
    ["anything with sk-private https://secret.example", "execution_failed"],
  ] as const)("maps %s to the closed public code %s", (input, expected) => {
    expect(mapAiFailureCode(input)).toBe(expected);
  });
});
