import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("optional Ollama acceptance contract", () => {
  const script = readFileSync("scripts/ollama-compose-smoke.mjs", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  it("is opt-in and tears down its isolated Compose project", () => {
    expect(script).toContain("OLLAMA_SMOKE");
    expect(script).toContain("Ollama smoke skipped");
    expect(script).toContain('"down", "--volumes", "--remove-orphans"');
    expect(script).toContain('"--profile",\n  "ollama"');
  });

  it("proves model availability, chat completion, and application health", () => {
    expect(script).toContain('"ollama", "ollama", "list"');
    expect(script).toContain("/v1/chat/completions");
    expect(script).toContain("/api/health/live");
    expect(packageJson.scripts?.["test:compose:ollama"]).toBe(
      "node scripts/ollama-compose-smoke.mjs",
    );
  });
});
