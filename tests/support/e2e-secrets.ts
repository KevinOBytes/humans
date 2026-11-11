import { randomBytes } from "node:crypto";

/**
 * Per-run throwaway secrets for the local end-to-end harness.
 *
 * Nothing here is a real credential and nothing is committed: each value is
 * read from an `E2E_*` environment variable when the operator supplies one,
 * otherwise generated once per run. Playwright forks workers from the main
 * process after the config has loaded, so a value assigned to `process.env`
 * here is inherited by every worker and web server instead of regenerating.
 */
function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function fromEnv(name: string, generate: () => string): string {
  const existing = process.env[name];
  if (existing !== undefined && existing !== "") return existing;
  const value = generate();
  process.env[name] = value;
  return value;
}

export const e2eSecrets = {
  get authSecret() {
    return fromEnv("E2E_AUTH_SECRET", () => hex(32));
  },
  get authEncryptionKey() {
    return fromEnv("E2E_AUTH_ENCRYPTION_KEY", () => hex(32));
  },
  get dataEncryptionKey() {
    return fromEnv("E2E_DATA_ENCRYPTION_KEY", () => hex(32));
  },
  get protectedLookupHmacKey() {
    return fromEnv("E2E_PROTECTED_LOOKUP_HMAC_KEY", () => hex(32));
  },
  get operationLimitHmacKey() {
    return fromEnv("E2E_OPERATION_LIMIT_HMAC_KEY", () => hex(32));
  },
  get adminPassword() {
    return fromEnv("E2E_ADMIN_PASSWORD", () => `Aa1!${hex(16)}`);
  },
  get resendApiKey() {
    return fromEnv("E2E_RESEND_API_KEY", () => `re_test_${hex(16)}`);
  },
  get graphPerformanceDiagnosticSecret() {
    return fromEnv("E2E_GRAPH_PERFORMANCE_DIAGNOSTIC_SECRET", () => hex(32));
  },
  get storageAccessKeyId() {
    return fromEnv("E2E_STORAGE_ACCESS_KEY_ID", () => `e2e${hex(6)}`);
  },
  get storageSecretAccessKey() {
    return fromEnv("E2E_STORAGE_SECRET_ACCESS_KEY", () => hex(24));
  },
  get fixtureUserPassword() {
    return fromEnv("E2E_FIXTURE_USER_PASSWORD", () => `Aa1!${hex(12)}`);
  },
};
