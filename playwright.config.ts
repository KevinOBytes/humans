import { defineConfig, devices } from "@playwright/test";

import { parseServerEnv } from "./src/lib/env/server-schema";

const baseURL = "http://127.0.0.1:3106";
const disabledBaseURL = "http://127.0.0.1:3108";
const inviteBaseURL = "http://127.0.0.1:3109";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://humans_test:humans_test@127.0.0.1:55439/humans_research_test";
const graphPerformance = process.env.GRAPH_PERFORMANCE === "1";
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const webServerEnv: Record<string, string> & NodeJS.ProcessEnv = {
  ...inheritedEnv,
  NODE_ENV: process.env.NODE_ENV ?? "test",
  DEPLOYMENT_MODE: "docker",
  NEXT_PUBLIC_APP_URL: baseURL,
  DATABASE_URL: databaseUrl,
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379",
  STORAGE_PROVIDER: "minio",
  STORAGE_ENDPOINT:
    process.env.TEST_STORAGE_ENDPOINT ?? "http://127.0.0.1:9000",
  STORAGE_REGION: process.env.TEST_STORAGE_REGION ?? "us-east-1",
  STORAGE_BUCKET: process.env.TEST_STORAGE_BUCKET ?? "humans-private",
  STORAGE_ACCESS_KEY_ID:
    process.env.TEST_STORAGE_ACCESS_KEY_ID ?? "local-playwright",
  STORAGE_SECRET_ACCESS_KEY:
    process.env.TEST_STORAGE_SECRET_ACCESS_KEY ??
    "local-playwright-storage-secret",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_BUCKET_PUBLIC: "false",
  AUTH_SECRET: "auth-fixture-signing-secret-0123456789abcdef0123456789abcdef",
  AUTH_SECURE_COOKIES: "false",
  AUTH_TRUSTED_ORIGINS: baseURL,
  AUTH_REGISTRATION_MODE: "public",
  AUTH_ENCRYPTION_KEY: "31".repeat(32),
  DATA_ENCRYPTION_KEY: "42".repeat(32),
  PROTECTED_LOOKUP_HMAC_KEY: "53".repeat(32),
  OPERATION_LIMIT_HMAC_KEY: "64".repeat(32),
  TRUSTED_PROXY_MODE: "none",
  ADMIN_EMAIL: "admin@example.test",
  ADMIN_USERNAME: "humans-admin",
  ADMIN_DISPLAY_NAME: "Humans Administrator",
  ADMIN_PASSWORD: "Task6InitialAdministratorPassword!2026",
  RESEND_API_KEY: "resend-fixture-key",
  RESEND_BASE_URL: "http://127.0.0.1:3107",
  EMAIL_FROM: "Humans <humans@example.test>",
  AI_PROVIDER: "ollama",
  AI_BASE_URL: "http://127.0.0.1:11434/v1",
  AI_MODEL: "fixture-model",
  GRAPH_PERFORMANCE_INSTRUMENTATION: graphPerformance ? "1" : "0",
  NEXT_PUBLIC_GRAPH_PERFORMANCE_INSTRUMENTATION: graphPerformance ? "1" : "0",
  GRAPH_PERFORMANCE_TEST_RUNTIME: graphPerformance ? "1" : "0",
  GRAPH_PERFORMANCE_DIAGNOSTIC_SECRET:
    "graph-reference-diagnostic-secret-2026-isolated-runtime",
};

function policyServerEnv(
  mode: "disabled" | "invite_only",
  url: string,
  distDir: string,
): Record<string, string> & NodeJS.ProcessEnv {
  return {
    ...webServerEnv,
    AUTH_REGISTRATION_MODE: mode,
    AUTH_TRUSTED_ORIGINS: url,
    NEXT_DIST_DIR: distDir,
    NEXT_PUBLIC_APP_URL: url,
  };
}

try {
  for (const environment of [
    webServerEnv,
    policyServerEnv("disabled", disabledBaseURL, ".next-disabled"),
    policyServerEnv("invite_only", inviteBaseURL, ".next-invite"),
  ]) {
    parseServerEnv(environment);
  }
} catch (cause) {
  throw new Error("Playwright web server environment is invalid", { cause });
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  projects: [
    { name: "chromium", testDir: "./tests/e2e" },
    {
      name: "graph-reference",
      testDir: "./tests/performance",
      testMatch: "graph-performance.spec.ts",
    },
  ],
  use: {
    ...devices["Desktop Chrome"],
    actionTimeout: 10_000,
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node tests/support/fake-resend-server.mjs",
      url: "http://127.0.0.1:3107/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...inheritedEnv, PORT: "3107" },
    },
    {
      command: graphPerformance
        ? "corepack pnpm build && PORT=3106 corepack pnpm start"
        : "corepack pnpm dev --hostname 127.0.0.1 --port 3106",
      url: `${baseURL}/api/health/live`,
      reuseExistingServer: false,
      timeout: graphPerformance ? 300_000 : 120_000,
      env: webServerEnv,
    },
    ...(!graphPerformance
      ? [
          {
            command: "corepack pnpm dev --hostname 127.0.0.1 --port 3108",
            url: `${disabledBaseURL}/api/health/live`,
            reuseExistingServer: false,
            timeout: 120_000,
            env: policyServerEnv("disabled", disabledBaseURL, ".next-disabled"),
          },
          {
            command: "corepack pnpm dev --hostname 127.0.0.1 --port 3109",
            url: `${inviteBaseURL}/api/health/live`,
            reuseExistingServer: false,
            timeout: 120_000,
            env: policyServerEnv("invite_only", inviteBaseURL, ".next-invite"),
          },
        ]
      : []),
  ],
});
