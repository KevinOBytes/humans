// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { readIntegrationDiagnostics } from "@/modules/settings/integration-diagnostics";

describe("settings integration diagnostics", () => {
  it("projects configuration only without network or dependency probes", () => {
    const fetch = vi.fn(() => {
      throw new Error("diagnostics must not contact providers");
    });
    vi.stubGlobal("fetch", fetch);
    const readEnvironment = vi.fn(() => ({
      DATABASE_URL: "postgresql://private.example/database",
      DEPLOYMENT_MODE: "docker" as const,
      EMAIL_FROM: "Humans <humans@example.test>",
      REDIS_URL: "rediss://private.example",
      RESEND_API_KEY: "private-resend-key",
      STORAGE_PROVIDER: "minio" as const,
    }));

    const value = readIntegrationDiagnostics(readEnvironment);

    expect(readEnvironment).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).not.toMatch(
      /private\.example|private-resend-key|postgresql:\/\/|rediss:\/\//u,
    );
    vi.unstubAllGlobals();
  });
});
