import { AsyncLocalStorage } from "node:async_hooks";

import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  APIError,
  betterAuth,
  type BetterAuthPlugin,
  type DBPrimitive,
} from "better-auth";
import { isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, organization, twoFactor, username } from "better-auth/plugins";

import {
  accounts,
  apiKeys,
  invitations,
  members,
  organizations,
  rateLimits,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@/db/schema/auth";
import type { EmailSender } from "@/lib/email/resend";
import type { ServerEnv } from "@/lib/env/server-schema";
import {
  noopSecurityEventLogger,
  type SecurityEventLogger,
} from "@/lib/observability/security-events";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  decryptAuthMaterial,
  encryptAuthMaterial,
} from "@/modules/auth/crypto";
import { ac, isWorkspaceRole, roles } from "@/modules/auth/permissions";
import { createRegistrationPolicyPlugin } from "@/modules/auth/registration-policy";
import { AUTH_RATE_LIMIT_ADDRESS_HEADER } from "@/modules/auth/request-headers";

const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

type ApiKeyVerificationState = { infrastructureFailure: boolean };

const apiKeyVerificationState =
  new AsyncLocalStorage<ApiKeyVerificationState>();

function createSanitizedBetterAuthLog(securityLogger: SecurityEventLogger) {
  return function sanitizedBetterAuthLog(
    level: "debug" | "error" | "info" | "warn",
    _message: string,
    ...values: unknown[]
  ): void {
    const expectedApiError =
      values.length > 0 &&
      values.every(
        (value) =>
          isAPIError(value) && value.status !== "INTERNAL_SERVER_ERROR",
      );
    const infrastructureFailure = level === "error" && !expectedApiError;
    if (infrastructureFailure) {
      const state = apiKeyVerificationState.getStore();
      if (state) state.infrastructureFailure = true;
      securityLogger.log({
        event: "auth.infrastructure.failure",
        severity: "error",
      });
      return;
    }
    if (level === "warn") {
      securityLogger.log({
        event: "auth.security.warning",
        severity: "warn",
      });
    }
  };
}

const generatedSchema = {
  accounts,
  apiKeys,
  invitations,
  members,
  organizations,
  rateLimits,
  sessions,
  twoFactors,
  users,
  verifications,
};

export const betterAuthSchema = {
  ...generatedSchema,
  account: accounts,
  apikey: apiKeys,
  invitation: invitations,
  member: members,
  organization: organizations,
  rateLimit: rateLimits,
  session: sessions,
  twoFactor: twoFactors,
  user: users,
  verification: verifications,
};

export type AuthSettings = Pick<
  ServerEnv,
  | "AUTH_ENCRYPTION_KEY"
  | "AUTH_REGISTRATION_MODE"
  | "AUTH_SECRET"
  | "AUTH_SECURE_COOKIES"
  | "AUTH_TRUSTED_ORIGINS"
  | "NEXT_PUBLIC_APP_URL"
>;

export type CreateHumansAuthOptions = {
  afterRegistrationPolicyCheck?: () => void | Promise<void>;
  database: Database;
  emailSender: EmailSender;
  /** Test-fixture seam; production callers must omit this and remain enabled. */
  rateLimitEnabled?: boolean;
  securityLogger?: SecurityEventLogger;
  settings: AuthSettings;
};

function assertWorkspaceRole(role: unknown): asserts role is string {
  if (!isWorkspaceRole(role) || role.includes(",")) {
    throw new APIError("BAD_REQUEST", {
      message: "A single valid workspace role is required",
    });
  }
}

function verificationEmail(url: string): { subject: string; text: string } {
  return {
    subject: "Verify your Humans email",
    text: `Verify your email address to continue using Humans:\n\n${url}\n\nThis link expires in one hour.`,
  };
}

function resetEmail(url: string): { subject: string; text: string } {
  return {
    subject: "Reset your Humans password",
    text: `Use this one-time link to reset your Humans password:\n\n${url}\n\nIf you did not request this, you can ignore this message.`,
  };
}

export function createAuthMaterialEncryptionPlugin(
  encryptionKey: string,
): BetterAuthPlugin {
  return {
    id: "humans-auth-material-encryption",
    schema: {
      twoFactor: {
        modelName: "twoFactors",
        fields: {
          secret: {
            type: "string",
            required: true,
            returned: false,
            index: true,
            transform: {
              input: async (value: DBPrimitive) => {
                if (typeof value !== "string") {
                  throw new Error(
                    "Unable to encrypt protected authentication material",
                  );
                }
                return encryptAuthMaterial(value, encryptionKey);
              },
              output: async (value: DBPrimitive) => {
                if (typeof value !== "string") {
                  throw new Error(
                    "Unable to decrypt protected authentication material",
                  );
                }
                return decryptAuthMaterial(value, encryptionKey);
              },
            },
          },
        },
      },
    },
  };
}

const minimalReadOnlyScopes = {
  person: ["read"],
  fact: ["read"],
  relationship: ["read"],
  evidence: ["read"],
  source: ["read"],
  file: ["read"],
  search: ["read"],
  graph: ["read"],
} as const;

export function createHumansAuth({
  afterRegistrationPolicyCheck,
  database,
  emailSender,
  rateLimitEnabled = true,
  securityLogger = noopSecurityEventLogger,
  settings,
}: CreateHumansAuthOptions) {
  if (
    typeof settings.AUTH_SECRET !== "string" ||
    settings.AUTH_SECRET.trim().length < 32
  ) {
    throw new Error("createHumansAuth requires a validated AUTH_SECRET");
  }

  if (settings.AUTH_ENCRYPTION_KEY === settings.AUTH_SECRET) {
    throw new Error("AUTH_ENCRYPTION_KEY must differ from AUTH_SECRET");
  }

  const authMaterialEncryption = createAuthMaterialEncryptionPlugin(
    settings.AUTH_ENCRYPTION_KEY,
  );
  const adminPlugin = admin({
    defaultRole: "user",
    adminRoles: ["admin"],
  });
  const humansAdminPlugin = {
    ...adminPlugin,
    schema: {
      ...adminPlugin.schema,
      user: {
        ...adminPlugin.schema.user,
        fields: {
          ...adminPlugin.schema.user.fields,
          role: {
            ...adminPlugin.schema.user.fields.role,
            defaultValue: "user",
          },
        },
      },
    },
  };

  return betterAuth({
    account: { modelName: "accounts" },
    advanced: {
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: {
        ipAddressHeaders: [AUTH_RATE_LIMIT_ADDRESS_HEADER],
      },
      useSecureCookies: settings.AUTH_SECURE_COOKIES,
    },
    baseURL: settings.NEXT_PUBLIC_APP_URL,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: betterAuthSchema,
      transaction: true,
    }),
    rateLimit: {
      enabled: rateLimitEnabled,
      modelName: "rateLimits",
      storage: "database",
      customRules: {
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 5 },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 16,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await emailSender.send({
          to: user.email,
          ...resetEmail(url),
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await emailSender.send({
          to: user.email,
          ...verificationEmail(url),
        });
      },
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
    },
    logger: {
      level: "warn",
      log: createSanitizedBetterAuthLog(securityLogger),
    },
    plugins: [
      createRegistrationPolicyPlugin({
        afterPolicyCheck: afterRegistrationPolicyCheck,
        database,
        mode: settings.AUTH_REGISTRATION_MODE,
        securityLogger,
      }),
      username({
        minUsernameLength: 3,
        maxUsernameLength: 64,
        usernameNormalization: (value) => value.toLowerCase(),
        usernameValidator: (value) => usernamePattern.test(value),
      }),
      twoFactor({
        issuer: "Humans",
        skipVerificationOnEnable: false,
        twoFactorTable: "twoFactors",
        schema: { twoFactor: { modelName: "twoFactors" } },
        backupCodeOptions: {
          amount: 10,
          length: 10,
          storeBackupCodes: {
            encrypt: (value) =>
              encryptAuthMaterial(value, settings.AUTH_ENCRYPTION_KEY),
            decrypt: (value) =>
              decryptAuthMaterial(value, settings.AUTH_ENCRYPTION_KEY),
          },
        },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 8,
          durationSeconds: 15 * 60,
        },
      }),
      authMaterialEncryption,
      humansAdminPlugin,
      organization({
        ac,
        roles,
        creatorRole: "owner",
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        dynamicAccessControl: { enabled: false },
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: 48 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        sendInvitationEmail: async (data) => {
          const url = new URL(
            "/accept-invitation",
            settings.NEXT_PUBLIC_APP_URL,
          );
          url.searchParams.set("id", data.id);
          await emailSender.send({
            to: data.email,
            subject: `Invitation to ${data.organization.name} on Humans`,
            text: `You were invited to join ${data.organization.name} on Humans. Accept the invitation within 48 hours:\n\n${url.toString()}`,
          });
        },
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation }) => {
            assertWorkspaceRole(invitation.role);
          },
          beforeAddMember: async ({ member }) => {
            assertWorkspaceRole(member.role);
          },
          beforeUpdateMemberRole: async ({ newRole }) => {
            assertWorkspaceRole(newRole);
          },
        },
        schema: {
          invitation: { modelName: "invitations" },
          member: {
            additionalFields: {
              workspaceId: {
                input: false,
                required: true,
                type: "string",
              },
            },
            modelName: "members",
          },
          organization: { modelName: "organizations" },
        },
      }),
      apiKey({
        configId: "organization",
        references: "organization",
        enableMetadata: true,
        enableSessionForAPIKeys: false,
        disableKeyHashing: false,
        requireName: true,
        defaultPrefix: "hum_",
        permissions: { defaultPermissions: minimalReadOnlyScopes },
        schema: { apikey: { modelName: "apiKeys" } },
      }),
      nextCookies(),
    ],
    secret: settings.AUTH_SECRET,
    session: { modelName: "sessions" },
    trustedOrigins: settings.AUTH_TRUSTED_ORIGINS,
    user: { modelName: "users" },
    verification: { modelName: "verifications" },
  });
}

export type BetterAuthRuntime = ReturnType<typeof createHumansAuth>;

export class AuthInfrastructureError extends Error {
  override readonly name = "AuthInfrastructureError";

  constructor() {
    super("Authentication infrastructure is unavailable");
  }
}

export async function verifyOrganizationApiKeyCredential(input: {
  auth: BetterAuthRuntime;
  checkHealth: () => Promise<void>;
  key: string;
}): Promise<Awaited<ReturnType<BetterAuthRuntime["api"]["verifyApiKey"]>>> {
  const state: ApiKeyVerificationState = { infrastructureFailure: false };
  return apiKeyVerificationState.run(state, async () => {
    let result: Awaited<ReturnType<BetterAuthRuntime["api"]["verifyApiKey"]>>;
    try {
      result = await input.auth.api.verifyApiKey({
        body: { configId: "organization", key: input.key },
      });
    } catch {
      throw new AuthInfrastructureError();
    }

    if (!result.valid || !result.key) {
      if (state.infrastructureFailure) throw new AuthInfrastructureError();
      try {
        await input.checkHealth();
      } catch {
        throw new AuthInfrastructureError();
      }
    }
    return result;
  });
}
