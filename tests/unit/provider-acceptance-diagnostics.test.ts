import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("provider acceptance diagnostics", () => {
  it("classifies local and opted-in external configuration without returning values", async () => {
    const smokeModule =
      (await import("../../scripts/production-readiness-smoke.mjs")) as unknown as {
        providerConfigurationDiagnostics?: (
          env: Record<string, string | undefined>,
        ) => unknown;
      };
    const privateValue = "private-provider-value-that-must-not-escape";

    const diagnostics = smokeModule.providerConfigurationDiagnostics?.({
      DATABASE_URL: privateValue,
      REDIS_URL: `redis://default:${privateValue}@redis:6379`,
      STORAGE_PROVIDER: "minio",
      STORAGE_ENDPOINT: `http://${privateValue}:9000`,
      STORAGE_REGION: "us-east-1",
      STORAGE_BUCKET: privateValue,
      STORAGE_ACCESS_KEY_ID: privateValue,
      STORAGE_SECRET_ACCESS_KEY: privateValue,
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_BUCKET_PUBLIC: "false",
      AI_PROVIDER: "ollama",
      AI_BASE_URL: `http://${privateValue}:11434/v1`,
      AI_MODEL: privateValue,
      RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
      UPSTASH_REDIS_REST_URL: "https://configured.example.test",
      TEST_STORAGE_PROVIDER: "r2",
      TEST_STORAGE_ENDPOINT: "https://configured.example.test",
      TEST_STORAGE_REGION: "auto",
      TEST_STORAGE_BUCKET: "isolated-contract-bucket",
      TEST_STORAGE_ACCESS_KEY_ID: privateValue,
      TEST_STORAGE_SECRET_ACCESS_KEY: privateValue,
      TEST_AI_PROVIDER: "openai",
      TEST_AI_BASE_URL: "https://configured.example.test/v1",
      TEST_AI_MODEL: privateValue,
    });

    expect(diagnostics).toEqual({
      kind: "provider-configuration",
      networkProbes: false,
      externalOptIn: {
        code: "ACCEPTANCE_EXTERNAL_OPT_IN_CONFIGURED",
        missing: [],
        status: "configured",
      },
      checks: [
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURED",
          missing: [],
          provider: "postgres",
          scope: "local",
          status: "configured",
        },
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURED",
          missing: [],
          provider: "redis",
          scope: "local",
          status: "configured",
        },
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURED",
          missing: [],
          provider: "minio",
          scope: "local",
          status: "configured",
        },
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURED",
          missing: [],
          provider: "ollama",
          scope: "local",
          status: "configured",
        },
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURATION_MISSING",
          missing: ["UPSTASH_REDIS_REST_TOKEN"],
          provider: "upstash",
          scope: "external",
          status: "missing",
        },
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURED",
          missing: [],
          provider: "r2",
          scope: "external",
          status: "configured",
        },
        {
          code: "ACCEPTANCE_PROVIDER_CONFIGURATION_MISSING",
          missing: ["TEST_AI_API_KEY"],
          provider: "openai",
          scope: "external",
          status: "missing",
        },
        {
          code: "ACCEPTANCE_PROVIDER_NOT_SELECTED",
          missing: ["TEST_RESEND_API_KEY"],
          provider: "resend",
          scope: "external",
          status: "not-selected",
        },
      ],
    });
    expect(JSON.stringify(diagnostics)).not.toContain(privateValue);
    expect(JSON.stringify(diagnostics)).not.toContain(
      "configured.example.test",
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "isolated-contract-bucket",
    );
  });

  it("prints diagnostics without requiring a base URL or starting the smoke", () => {
    const privateValue = "diagnostic-cli-private-value";
    const result = spawnSync(
      process.execPath,
      [
        resolve(process.cwd(), "scripts/production-readiness-smoke.mjs"),
        "--diagnose-provider-config",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          DATABASE_URL: privateValue,
          NODE_ENV: "test",
          PATH: process.env.PATH,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const diagnostics = JSON.parse(result.stdout) as {
      checks: unknown[];
      kind: string;
      networkProbes: boolean;
    };
    expect(diagnostics).toMatchObject({
      kind: "provider-configuration",
      networkProbes: false,
    });
    expect(diagnostics.checks[0]).toMatchObject({
      code: "ACCEPTANCE_PROVIDER_CONFIGURED",
      provider: "postgres",
      scope: "local",
      status: "configured",
    });
    expect(result.stdout).not.toContain(privateValue);
  });

  it("does not report selected external runtime adapters as missing local configuration", async () => {
    const { providerConfigurationDiagnostics } =
      await import("../../scripts/production-readiness-smoke.mjs");
    const privateValue = "selected-external-runtime-value";

    const diagnostics = providerConfigurationDiagnostics({
      DEPLOYMENT_MODE: "vercel",
      DATABASE_URL: privateValue,
      REDIS_URL: `rediss://${privateValue}@configured.example.test:6379`,
      REDIS_TOKEN: privateValue,
      STORAGE_PROVIDER: "r2",
      AI_PROVIDER: "openai",
    });

    expect(diagnostics.checks.slice(0, 4)).toEqual([
      {
        code: "ACCEPTANCE_PROVIDER_NOT_SELECTED",
        missing: [],
        provider: "postgres",
        scope: "local",
        status: "not-selected",
      },
      {
        code: "ACCEPTANCE_PROVIDER_NOT_SELECTED",
        missing: [],
        provider: "redis",
        scope: "local",
        status: "not-selected",
      },
      {
        code: "ACCEPTANCE_PROVIDER_NOT_SELECTED",
        missing: [],
        provider: "minio",
        scope: "local",
        status: "not-selected",
      },
      {
        code: "ACCEPTANCE_PROVIDER_NOT_SELECTED",
        missing: [],
        provider: "ollama",
        scope: "local",
        status: "not-selected",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(privateValue);
    expect(JSON.stringify(diagnostics)).not.toContain(
      "configured.example.test",
    );
  });
});
