import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { buildIntegrationDiagnostics } from "@/modules/settings/read-model";

type DiagnosticEnvironment = Pick<
  ReturnType<typeof getServerEnv>,
  | "DATABASE_URL"
  | "DEPLOYMENT_MODE"
  | "EMAIL_FROM"
  | "REDIS_URL"
  | "RESEND_API_KEY"
  | "STORAGE_PROVIDER"
>;

type DiagnosticEnvironmentWithAi = DiagnosticEnvironment & {
  AI_PROVIDER?: string;
};

export function readIntegrationDiagnostics(
  readEnvironment: () => DiagnosticEnvironmentWithAi,
) {
  const env = readEnvironment();
  return buildIntegrationDiagnostics({
    deploymentMode: env.DEPLOYMENT_MODE,
    emailConfigured: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    databaseConfigured: Boolean(env.DATABASE_URL),
    redisConfigured: Boolean(env.REDIS_URL),
    storageProvider: env.STORAGE_PROVIDER,
    providerBackendAvailable: Boolean(env.AI_PROVIDER),
  });
}

export function getIntegrationDiagnostics() {
  return readIntegrationDiagnostics(getServerEnv);
}
