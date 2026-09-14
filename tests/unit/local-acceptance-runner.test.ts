import { describe, expect, it } from "vitest";

describe("hermetic local acceptance runner", () => {
  it("does not forward ambient service, reset, or provider configuration to its test child", async () => {
    const runnerModule =
      (await import("../../scripts/run-local-acceptance.mjs")) as unknown as {
        runLocalAcceptance?: (options: {
          env: Record<string, string | undefined>;
          execute: (input: {
            args: string[];
            env: Record<string, string | undefined>;
          }) => Promise<{ exitCode: number }>;
          log: (line: string) => void;
        }) => Promise<unknown>;
      };
    const privateValue = "ambient-value-that-must-not-reach-a-child";
    const executions: Array<{
      args: string[];
      env: Record<string, string | undefined>;
    }> = [];
    const logs: string[] = [];

    const result = await runnerModule.runLocalAcceptance?.({
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: `--require=${privateValue}`,
        PATH: process.env.PATH,
        DOCKER_HOST: `tcp://${privateValue}:2375`,
        DATABASE_URL: `postgres://reset:${privateValue}@database/humans`,
        POSTGRES_URL: `postgres://reset:${privateValue}@database/humans`,
        TEST_DATABASE_URL: `postgres://reset:${privateValue}@database/humans_test`,
        ALLOW_TEST_DATABASE_RESET: "true",
        REDIS_URL: `redis://:${privateValue}@redis:6379`,
        REDIS_TEST_URL: `redis://:${privateValue}@redis:6379`,
        TEST_REDIS_URL: `redis://:${privateValue}@redis:6379`,
        STORAGE_PROVIDER: "s3",
        STORAGE_ENDPOINT: "https://storage.example.test",
        STORAGE_BUCKET: privateValue,
        STORAGE_ACCESS_KEY_ID: privateValue,
        STORAGE_SECRET_ACCESS_KEY: privateValue,
        AI_PROVIDER: "openai",
        AI_BASE_URL: "https://ai.example.test",
        AI_API_KEY: privateValue,
        RESEND_API_KEY: privateValue,
        RUN_EXTERNAL_PROVIDER_CONTRACTS: "true",
        TEST_STORAGE_PROVIDER: "r2",
        TEST_STORAGE_ENDPOINT: "https://storage.example.test",
        TEST_STORAGE_BUCKET: privateValue,
        TEST_STORAGE_SECRET_ACCESS_KEY: privateValue,
        TEST_AI_PROVIDER: "openai",
        TEST_AI_API_KEY: privateValue,
        TEST_RESEND_API_KEY: privateValue,
      },
      execute: async (input) => {
        executions.push(input);
        return { exitCode: 0 };
      },
      log: (line) => logs.push(line),
    });

    expect(executions).toHaveLength(1);
    expect(executions[0]?.env).toEqual({
      NODE_ENV: "test",
      PATH: process.env.PATH,
    });
    expect(executions[0]?.args).toContain(
      "tests/unit/graphql-route-boundary.test.ts",
    );
    expect(executions[0]?.args).toContain(
      "tests/unit/graphql-error-contract.test.ts",
    );
    expect(executions[0]?.args).toContain(
      "tests/unit/graphql-server-error-contract.test.ts",
    );
    expect(executions[0]?.args).not.toContain(
      "tests/integration/graphql-security-boundaries.test.ts",
    );
    expect(result).toMatchObject({ exitCode: 0 });
    expect(logs.join("\n")).not.toContain(privateValue);
    expect(logs.join("\n")).toContain('"networkProbes":false');
  });
});
