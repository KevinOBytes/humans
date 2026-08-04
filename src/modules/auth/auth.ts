import "server-only";

import { db } from "@/db/client";
import { createHumansAuth, type BetterAuthRuntime } from "@/lib/auth/config";
import { createEmailSender } from "@/lib/email/resend";
import { getServerEnv } from "@/lib/env/server";
import { productionSecurityEventLogger } from "@/lib/observability/security-events";

const env = getServerEnv();

export const auth: BetterAuthRuntime = createHumansAuth({
  database: db,
  emailSender: createEmailSender(env),
  securityLogger: productionSecurityEventLogger,
  settings: env,
});

export { createHumansAuth } from "@/lib/auth/config";
export type { BetterAuthRuntime } from "@/lib/auth/config";
export {
  ensureApiKeyPrincipal,
  ensureUserPrincipal,
  provisionOrganizationApiKey,
  provisionWorkspace,
  resolveActiveWorkspace,
  verifyOrganizationApiKey,
} from "./workspaces";
