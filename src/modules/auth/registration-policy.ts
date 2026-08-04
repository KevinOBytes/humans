import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { invitations } from "@/db/schema/auth";
import { workspaces } from "@/db/schema/workspaces";
import type { SecurityEventLogger } from "@/lib/observability/security-events";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { AUTH_REQUEST_ID_HEADER } from "@/modules/auth/request-headers";

export const registrationModes = ["disabled", "invite_only", "public"] as const;
export type RegistrationMode = (typeof registrationModes)[number];

export const REGISTRATION_UNAVAILABLE_MESSAGE =
  "Registration is unavailable for these details.";

type RegistrationPolicyInput = {
  email: string;
  hasPendingInvitation: (normalizedEmail: string) => Promise<boolean>;
  mode: RegistrationMode;
};

export class RegistrationUnavailableError extends Error {
  override readonly name = "RegistrationUnavailableError";

  constructor() {
    super(REGISTRATION_UNAVAILABLE_MESSAGE);
  }
}

function requestId(headers: Headers | undefined): string {
  const value = headers?.get(AUTH_REQUEST_ID_HEADER)?.trim();
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
    ? value.toLowerCase()
    : crypto.randomUUID();
}

export async function assertRegistrationAllowed({
  email,
  hasPendingInvitation,
  mode,
}: RegistrationPolicyInput): Promise<void> {
  if (mode === "public") return;
  if (mode === "disabled") throw new RegistrationUnavailableError();

  try {
    const allowed = await hasPendingInvitation(email.trim().toLowerCase());
    if (allowed) return;
  } catch {
    // Fail closed with the same public response as a missing invitation.
  }
  throw new RegistrationUnavailableError();
}

export function createRegistrationPolicyPlugin(input: {
  afterPolicyCheck?: () => void | Promise<void>;
  database: Database;
  mode: RegistrationMode;
  securityLogger: SecurityEventLogger;
}): BetterAuthPlugin {
  async function hasLiveInvitation(normalizedEmail: string, lock: boolean) {
    const query = input.database
      .select({ id: invitations.id })
      .from(invitations)
      .innerJoin(
        workspaces,
        eq(workspaces.organizationId, invitations.organizationId),
      )
      .where(
        and(
          sql`lower(${invitations.email}) = ${normalizedEmail}`,
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, new Date()),
          eq(workspaces.state, "active"),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    const rows = lock ? await query.for("update") : await query;
    return rows.length === 1;
  }

  return {
    id: "humans-registration-policy",
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              before: async (user, context) => {
                if (context?.path !== "/sign-up/email") return;
                if (input.mode === "public") return;
                if (
                  input.mode === "disabled" ||
                  typeof user.email !== "string" ||
                  !(await hasLiveInvitation(
                    user.email.trim().toLowerCase(),
                    false,
                  ))
                ) {
                  throw new APIError("BAD_REQUEST", {
                    message: REGISTRATION_UNAVAILABLE_MESSAGE,
                  });
                }
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/sign-up/email",
          handler: createAuthMiddleware(async (context) => {
            const correlationId = requestId(context.headers);
            const email =
              typeof context.body.email === "string" ? context.body.email : "";
            try {
              await assertRegistrationAllowed({
                email,
                mode: input.mode,
                hasPendingInvitation: (normalizedEmail) =>
                  hasLiveInvitation(normalizedEmail, true),
              });
              await input.afterPolicyCheck?.();
              input.securityLogger.log({
                event: "auth.registration.allowed",
                requestId: correlationId,
                severity: "info",
              });
            } catch {
              input.securityLogger.log({
                event: "auth.registration.denied",
                requestId: correlationId,
                severity: "warn",
              });
              throw new APIError("BAD_REQUEST", {
                message: REGISTRATION_UNAVAILABLE_MESSAGE,
              });
            }
          }),
        },
        {
          matcher: (context) => context.path === "/request-password-reset",
          handler: createAuthMiddleware(async (context) => {
            input.securityLogger.log({
              event: "auth.recovery.requested",
              requestId: requestId(context.headers),
              severity: "info",
            });
          }),
        },
      ],
    },
  };
}
