// @vitest-environment node

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createAuthRouteHandlers } from "@/app/api/auth/[...all]/route";
import { newId } from "@/db/id";
import { authEmailOutbox } from "@/db/schema/auth-email-outbox";
import {
  accounts,
  apiKeys,
  invitations,
  members,
  organizations,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import { workspacePrincipals } from "@/db/schema/principals";
import { workspaces } from "@/db/schema/workspaces";
import { createHumansAuth } from "@/lib/auth/config";
import {
  ResendEmailSender,
  type EmailMessage,
  type EmailSender,
} from "@/lib/email/resend";
import type { SecurityEvent } from "@/lib/observability/security-events";
import {
  ensureApiKeyPrincipal,
  ensureUserPrincipal,
  provisionOrganizationApiKey,
  provisionWorkspace,
  resolveActiveWorkspace,
  verifyOrganizationApiKey,
} from "@/modules/auth/workspaces";
import { decryptAuthMaterial } from "@/modules/auth/crypto";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  cleanupAuthEmailOutbox,
  createAuthEmailOutboxSender,
  runAuthEmailOutboxOnce,
} from "@/modules/auth/email-outbox";
import { acceptInvitationAtomically } from "@/modules/auth/invitation-lifecycle";
import { createTransactionalInviteSignUpHandler } from "@/modules/auth/invite-signup";
import {
  AUTH_REQUEST_ID_HEADER,
  decorateAuthBoundaryResponse,
} from "@/modules/auth/request-boundary";
import { changeTwoFactorStateAtomically } from "@/modules/auth/two-factor-lifecycle";
import {
  CookieJar,
  TestEmailSender,
  authRequest,
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
  responseJson,
  testAdminEnv,
} from "../support/auth";

const connection = process.env.TEST_DATABASE_URL
  ? createTestConnection(16)
  : undefined;
const database = connection ? createTestDatabase(connection) : undefined;
const liveDescribe = connection ? describe : describe.skip;

type Runtime = ReturnType<typeof createHumansAuth>;

const accountPassword = ["Correct", "Horse", "Battery", "Staple!", "2026"].join(
  "",
);

function emailUrl(sender: TestEmailSender, subject: RegExp): string {
  const message = [...sender.messages]
    .reverse()
    .find((candidate) => subject.test(candidate.subject));
  if (!message) throw new Error("Expected email was not captured");
  const body = `${message.text ?? ""}\n${message.html ?? ""}`;
  const match = body.match(/https?:\/\/[^\s<>"]+/u);
  if (!match) throw new Error("Expected email URL was not captured");
  return match[0].replaceAll("&amp;", "&");
}

function actionCredential(url: string): string {
  const parsed = new URL(url);
  const credential =
    parsed.searchParams.get("token") ??
    parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!credential)
    throw new Error("Expected action credential was not captured");
  return credential;
}

function responseShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(responseShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, responseShape(nested)]),
    );
  }
  return value === null ? "null" : typeof value;
}

function jarHeaders(jar: CookieJar): Headers {
  const headers = new Headers({
    origin: new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin,
  });
  jar.apply(headers);
  return headers;
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase().replaceAll("=", "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid TOTP fixture secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(uri: string): string {
  const parsed = new URL(uri);
  const secret = parsed.searchParams.get("secret");
  if (!secret) throw new Error("Missing TOTP fixture secret");
  const period = Number(parsed.searchParams.get("period") ?? "30");
  const digits = Number(parsed.searchParams.get("digits") ?? "6");
  const counter = BigInt(Math.floor(Date.now() / 1000 / period));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) >>>
    0;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

async function signUp(
  runtime: Runtime,
  sender: TestEmailSender,
  input: { email: string; username: string; name?: string },
): Promise<Response> {
  const response = await authRequest(
    runtime.handler,
    "/api/auth/sign-up/email",
    {
      body: {
        name: input.name ?? input.username,
        email: input.email,
        username: input.username,
        displayUsername: input.username,
        password: accountPassword,
      },
    },
  );
  expect(sender.messages.at(-1)?.to).toBe(input.email.toLowerCase());
  return response;
}

async function verifyLatestEmail(
  runtime: Runtime,
  sender: TestEmailSender,
): Promise<Response> {
  return runtime.handler(new Request(emailUrl(sender, /verify/i)));
}

async function createVerifiedUser(
  runtime: Runtime,
  sender: TestEmailSender,
  input: { email: string; username: string; name?: string },
): Promise<{ jar: CookieJar; userId: string }> {
  expect((await signUp(runtime, sender, input)).status).toBe(200);
  expect((await verifyLatestEmail(runtime, sender)).status).toBeLessThan(400);
  const jar = new CookieJar();
  const signIn = await authRequest(runtime.handler, "/api/auth/sign-in/email", {
    body: { email: input.email, password: accountPassword },
    jar,
  });
  expect(signIn.status).toBe(200);
  const [user] = await database!
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()));
  return { jar, userId: user!.id };
}

async function createOwner(runtime: Runtime, sender: TestEmailSender) {
  const identity = await createVerifiedUser(runtime, sender, {
    email: "owner@example.test",
    username: "WorkspaceOwner",
    name: "Workspace Owner",
  });
  const workspace = await provisionWorkspace(database!, {
    userId: identity.userId,
    name: "Investigation Alpha",
    slug: `investigation-${newId()}`,
  });
  const setActive = await authRequest(
    runtime.handler,
    "/api/auth/organization/set-active",
    {
      body: { organizationId: workspace.organizationId },
      jar: identity.jar,
    },
  );
  expect(setActive.status).toBe(200);
  return { ...identity, ...workspace };
}

liveDescribe("Better Auth security boundary", () => {
  let emailSender: TestEmailSender;
  let runtime: Runtime;
  let securityEvents: SecurityEvent[];

  beforeEach(async () => {
    await resetTestDatabase(connection!);
    emailSender = new TestEmailSender();
    securityEvents = [];
    runtime = createHumansAuth({
      database: database!,
      emailSender,
      securityLogger: {
        log: (event) => securityEvents.push(event),
      },
      settings: testAdminEnv,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await connection?.end();
  });

  it("uses the required plugin order and exports every Next.js method", async () => {
    expect(runtime.options.rateLimit?.enabled).toBe(true);
    const pluginIds = runtime.options.plugins?.map((plugin) => plugin.id);
    expect(pluginIds).toEqual([
      "humans-registration-policy",
      "username",
      "two-factor",
      "humans-auth-material-encryption",
      "admin",
      "organization",
      "api-key",
      "next-cookies",
    ]);

    const route = await readFile("src/app/api/auth/[...all]/route.ts", "utf8");
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      expect(route).toMatch(new RegExp(`\\b${method}\\b`));
    }
  });

  it("enforces disabled, public, and live same-email invitation registration modes", async () => {
    const disabledRuntime = createHumansAuth({
      database: database!,
      emailSender,
      settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "disabled" },
    });
    const denied = await authRequest(
      disabledRuntime.handler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Denied",
          email: "denied@example.test",
          username: "DeniedUser",
          displayUsername: "DeniedUser",
          password: accountPassword,
        },
      },
    );
    expect(denied.status).toBe(400);
    const deniedBody = await responseJson(denied);
    expect(JSON.stringify(deniedBody)).not.toContain("invitation");
    expect(await database!.select().from(users)).toHaveLength(0);

    const owner = await createOwner(runtime, emailSender);
    await database!.insert(invitations).values([
      {
        id: newId(),
        organizationId: owner.organizationId,
        email: "Invited@Example.test",
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      },
      {
        id: newId(),
        organizationId: owner.organizationId,
        email: "expired@example.test",
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() - 60_000),
        inviterId: owner.userId,
      },
    ]);
    const inviteRuntime = createHumansAuth({
      database: database!,
      emailSender,
      settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "invite_only" },
    });

    const invited = await signUp(inviteRuntime, emailSender, {
      email: "invited@example.test",
      username: "InvitedUser",
    });
    expect(invited.status).toBe(200);
    const invitationAfterSignup = await database!
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.email, "Invited@Example.test"));
    expect(invitationAfterSignup).toEqual([{ status: "pending" }]);

    for (const email of ["expired@example.test", "missing@example.test"]) {
      const response = await authRequest(
        inviteRuntime.handler,
        "/api/auth/sign-up/email",
        {
          body: {
            name: "Unavailable",
            email,
            username: `Unavailable${email.length}`,
            displayUsername: `Unavailable${email.length}`,
            password: accountPassword,
          },
        },
      );
      expect(response.status).toBe(400);
      expect(responseShape(await responseJson(response))).toEqual(
        responseShape(deniedBody),
      );
    }
  });

  it("returns the same sanitized correlation emitted by registration policy events", async () => {
    const events: SecurityEvent[] = [];
    const disabledRuntime = createHumansAuth({
      database: database!,
      emailSender,
      securityLogger: { log: (event) => events.push(event) },
      settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "disabled" },
    });
    const suppliedId = "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1";
    const correlationId = suppliedId.toLowerCase();
    const raw = await authRequest(
      disabledRuntime.handler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Denied",
          email: "correlated-denied@example.test",
          username: "CorrelatedDenied",
          displayUsername: "CorrelatedDenied",
          password: accountPassword,
        },
        headers: {
          [AUTH_REQUEST_ID_HEADER]: correlationId,
        },
      },
    );
    const response = await decorateAuthBoundaryResponse(raw, correlationId);

    expect(correlationId).toBe(suppliedId.toLowerCase());
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe(correlationId);
    await expect(responseJson(response)).resolves.toMatchObject({
      requestId: correlationId,
    });
    expect(events).toEqual([
      {
        event: "auth.registration.denied",
        requestId: correlationId,
        severity: "warn",
      },
    ]);
  });

  it("keeps invitation state and membership safe across signup races and delivery failure", async () => {
    const owner = await createOwner(runtime, emailSender);
    const raceInvitationId = newId();
    await database!.insert(invitations).values({
      id: raceInvitationId,
      organizationId: owner.organizationId,
      email: "race-invite@example.test",
      role: "viewer",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: owner.userId,
    });
    const inviteRuntime = createHumansAuth({
      database: database!,
      emailSender,
      settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "invite_only" },
    });
    const attempts = await Promise.all([
      signUp(inviteRuntime, emailSender, {
        email: "race-invite@example.test",
        username: "RaceInviteOne",
      }),
      signUp(inviteRuntime, emailSender, {
        email: "race-invite@example.test",
        username: "RaceInviteTwo",
      }),
    ]);
    expect(attempts.some((response) => response.status === 200)).toBe(true);
    const raceUsers = await database!
      .select({ id: users.id, verified: users.emailVerified })
      .from(users)
      .where(eq(users.email, "race-invite@example.test"));
    expect(raceUsers).toHaveLength(1);
    expect(raceUsers[0]?.verified).toBe(false);
    expect(
      await database!
        .select()
        .from(members)
        .where(eq(members.userId, raceUsers[0]!.id)),
    ).toEqual([]);
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, raceInvitationId)),
    ).toEqual([{ status: "pending" }]);

    await database!
      .update(invitations)
      .set({ status: "cancelled" })
      .where(eq(invitations.id, raceInvitationId));
    await verifyLatestEmail(inviteRuntime, emailSender);
    const raceJar = new CookieJar();
    await authRequest(inviteRuntime.handler, "/api/auth/sign-in/email", {
      body: { email: "race-invite@example.test", password: accountPassword },
      jar: raceJar,
    });
    const cancelledAcceptance = await authRequest(
      inviteRuntime.handler,
      "/api/auth/organization/accept-invitation",
      { body: { invitationId: raceInvitationId }, jar: raceJar },
    );
    expect(cancelledAcceptance.status).toBe(400);
    expect(
      await database!
        .select()
        .from(members)
        .where(eq(members.userId, raceUsers[0]!.id)),
    ).toEqual([]);

    const failedInvitationId = newId();
    await database!.insert(invitations).values({
      id: failedInvitationId,
      organizationId: owner.organizationId,
      email: "mail-failure@example.test",
      role: "viewer",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: owner.userId,
    });
    const failingMailRuntime = createHumansAuth({
      database: database!,
      emailSender: {
        send: async () => {
          throw new Error("injected delivery failure");
        },
      },
      settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "invite_only" },
    });
    const failedSignup = await authRequest(
      failingMailRuntime.handler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Mail Failure",
          email: "mail-failure@example.test",
          username: "MailFailure",
          displayUsername: "MailFailure",
          password: accountPassword,
        },
      },
    );
    // Better Auth deliberately acknowledges account creation even when the
    // asynchronous verification delivery fails. The account remains
    // unverified and cannot consume the invitation or create membership.
    expect(failedSignup.status).toBe(200);
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, failedInvitationId)),
    ).toEqual([{ status: "pending" }]);
    const [failedUser] = await database!
      .select({ id: users.id, verified: users.emailVerified })
      .from(users)
      .where(eq(users.email, "mail-failure@example.test"));
    if (failedUser) {
      expect(failedUser.verified).toBe(false);
      expect(
        await database!
          .select()
          .from(members)
          .where(eq(members.userId, failedUser.id)),
      ).toEqual([]);
    }
  });

  it("linearizes invite-only signup through insertion and rolls back expired authorization", async () => {
    const owner = await createOwner(runtime, emailSender);
    const cancellationInvitationId = newId();
    const expiryInvitationId = newId();
    await database!.insert(invitations).values([
      {
        id: cancellationInvitationId,
        organizationId: owner.organizationId,
        email: "linearized-cancel@example.test",
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      },
      {
        id: expiryInvitationId,
        organizationId: owner.organizationId,
        email: "linearized-expiry@example.test",
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() + 150),
        inviterId: owner.userId,
      },
    ]);

    let cancellation: Promise<unknown> | undefined;
    let cancellationSettled = false;
    const cancellationHandler = createTransactionalInviteSignUpHandler({
      database: database!,
      createHandler: (transaction) =>
        createHumansAuth({
          afterRegistrationPolicyCheck: async () => {
            cancellation = database!
              .update(invitations)
              .set({ status: "cancelled" })
              .where(eq(invitations.id, cancellationInvitationId))
              .then(() => {
                cancellationSettled = true;
              });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(cancellationSettled).toBe(false);
          },
          database: transaction,
          emailSender,
          rateLimitEnabled: false,
          settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "invite_only" },
        }).handler,
    });
    const allowed = await authRequest(
      cancellationHandler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Linearized Cancel",
          email: "linearized-cancel@example.test",
          username: "LinearizedCancel",
          displayUsername: "LinearizedCancel",
          password: accountPassword,
        },
      },
    );
    expect(allowed.status).toBe(200);
    await cancellation;
    expect(cancellationSettled).toBe(true);
    expect(
      await database!
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "linearized-cancel@example.test")),
    ).toHaveLength(1);
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, cancellationInvitationId)),
    ).toEqual([{ status: "cancelled" }]);

    const expiryHandler = createTransactionalInviteSignUpHandler({
      database: database!,
      createHandler: (transaction) =>
        createHumansAuth({
          afterRegistrationPolicyCheck: () =>
            new Promise((resolve) => setTimeout(resolve, 200)),
          database: transaction,
          emailSender,
          rateLimitEnabled: false,
          settings: { ...testAdminEnv, AUTH_REGISTRATION_MODE: "invite_only" },
        }).handler,
    });
    const expired = await authRequest(
      expiryHandler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Linearized Expiry",
          email: "linearized-expiry@example.test",
          username: "LinearizedExpiry",
          displayUsername: "LinearizedExpiry",
          password: accountPassword,
        },
      },
    );
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect(
      await database!
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "linearized-expiry@example.test")),
    ).toEqual([]);
    expect(
      await database!
        .select({ id: accounts.id })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.userId))
        .where(eq(users.email, "linearized-expiry@example.test")),
    ).toEqual([]);
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, expiryInvitationId)),
    ).toEqual([{ status: "pending" }]);
  });

  it("atomically commits invite signup and its encrypted verification intent before delivery", async () => {
    const email = "outbox-signup@example.test";
    const invitationId = newId();
    const owner = await createOwner(runtime, emailSender);
    await database!.insert(invitations).values({
      id: invitationId,
      organizationId: owner.organizationId,
      email,
      role: "viewer",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: owner.userId,
    });

    const delivered = new TestEmailSender();
    const allowed: SecurityEvent[] = [];
    const failingDatabase = {
      transaction: (callback: Parameters<Database["transaction"]>[0]) =>
        database!.transaction(async (transaction) => {
          await callback(transaction);
          throw new Error("synthetic commit failure");
        }),
    } as unknown as NonNullable<typeof database>;
    const failed = createTransactionalInviteSignUpHandler({
      database: failingDatabase,
      createHandler: (transaction) => {
        const outbox = createAuthEmailOutboxSender({
          authSecret: testAdminEnv.AUTH_SECRET,
          database: transaction,
          encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
        });
        const pending: SecurityEvent[] = [];
        return {
          handler: createHumansAuth({
            database: transaction,
            emailSender: outbox.sender,
            rateLimitEnabled: false,
            securityLogger: {
              log: (event) => {
                if (event.event === "auth.registration.allowed")
                  pending.push(event);
              },
            },
            settings: {
              ...testAdminEnv,
              AUTH_REGISTRATION_MODE: "invite_only",
            },
          }).handler,
          afterCommit: async () => {
            allowed.push(...pending);
            await runAuthEmailOutboxOnce({
              database: database!,
              emailSender: delivered,
              encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
              ids: outbox.queuedIds,
            });
          },
        };
      },
    });
    await expect(
      authRequest(failed, "/api/auth/sign-up/email", {
        body: {
          name: "Outbox Signup",
          email,
          username: "OutboxSignup",
          displayUsername: "OutboxSignup",
          password: accountPassword,
        },
      }),
    ).rejects.toThrow("synthetic commit failure");
    expect(delivered.messages).toEqual([]);
    expect(allowed).toEqual([]);
    expect(await database!.select().from(authEmailOutbox)).toEqual([]);
    expect(
      await database!.select().from(users).where(eq(users.email, email)),
    ).toEqual([]);

    let committed = false;
    const providerCalls: Array<{
      message: EmailMessage;
      idempotencyKey?: string;
    }> = [];
    const unavailableSender: EmailSender = {
      send: async (message, options) => {
        expect(committed).toBe(true);
        await database!.transaction(async (transaction) => {
          await transaction
            .select({ id: invitations.id })
            .from(invitations)
            .where(eq(invitations.id, invitationId))
            .for("update", { noWait: true });
        });
        providerCalls.push({
          message,
          idempotencyKey: options?.idempotencyKey,
        });
        throw new Error("provider credential detail");
      },
    };
    const successful = createTransactionalInviteSignUpHandler({
      database: database!,
      createHandler: (transaction) => {
        const outbox = createAuthEmailOutboxSender({
          authSecret: testAdminEnv.AUTH_SECRET,
          database: transaction,
          encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
        });
        const pending: SecurityEvent[] = [];
        return {
          handler: createHumansAuth({
            database: transaction,
            emailSender: outbox.sender,
            rateLimitEnabled: false,
            securityLogger: {
              log: (event) => {
                if (event.event === "auth.registration.allowed")
                  pending.push(event);
              },
            },
            settings: {
              ...testAdminEnv,
              AUTH_REGISTRATION_MODE: "invite_only",
            },
          }).handler,
          afterCommit: async () => {
            committed = true;
            allowed.push(...pending);
            await runAuthEmailOutboxOnce({
              database: database!,
              emailSender: unavailableSender,
              encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
              ids: outbox.queuedIds,
            });
          },
        };
      },
    });
    const response = await authRequest(successful, "/api/auth/sign-up/email", {
      body: {
        name: "Outbox Signup",
        email,
        username: "OutboxSignup",
        displayUsername: "OutboxSignup",
        password: accountPassword,
      },
    });
    expect(response.status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.idempotencyKey).toMatch(/^auth-verification-/u);
    expect(allowed).toHaveLength(1);
    const [intent] = await database!.select().from(authEmailOutbox);
    expect(intent).toMatchObject({
      attemptCount: 1,
      errorCode: "delivery_unavailable",
      state: "queued",
    });
    expect(JSON.stringify(intent)).not.toContain(email);
    expect(JSON.stringify(intent)).not.toContain("token=");
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, invitationId)),
    ).toEqual([{ status: "pending" }]);

    await database!
      .update(authEmailOutbox)
      .set({ scheduledAt: new Date(0) })
      .where(eq(authEmailOutbox.id, intent!.id));
    const retryCalls: Array<{ idempotencyKey?: string }> = [];
    const retry: EmailSender = {
      send: async (_message, options) => {
        retryCalls.push({ idempotencyKey: options?.idempotencyKey });
        return { id: "retry-provider-id" };
      },
    };
    const retrySummary = await runAuthEmailOutboxOnce({
      database: database!,
      emailSender: retry,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      ids: [intent!.id],
    });
    expect(retrySummary).toMatchObject({ claimed: 1, completed: 1 });
    expect(retryCalls).toEqual([
      { idempotencyKey: providerCalls[0]?.idempotencyKey },
    ]);
  });

  it("claims auth email intents once and fences stale completion generations", async () => {
    const queued = createAuthEmailOutboxSender({
      authSecret: testAdminEnv.AUTH_SECRET,
      database: database!,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
    });
    await queued.sender.send({
      to: "lease-fence@example.test",
      subject: "Verify your Humans email",
      text: "https://humans.example.test/verify?token=lease-fence-secret",
    });
    const id = queued.queuedIds[0]!;
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const idempotencyKeys: string[] = [];
    const slowSender: EmailSender = {
      send: async (_message, options) => {
        idempotencyKeys.push(options?.idempotencyKey ?? "");
        providerStarted();
        await blocked;
        return { id: "slow-provider-id" };
      },
    };
    const first = runAuthEmailOutboxOnce({
      database: database!,
      emailSender: slowSender,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      ids: [id],
      workerId: "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1",
    });
    await started;
    const concurrent = await runAuthEmailOutboxOnce({
      database: database!,
      emailSender: new TestEmailSender(),
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      ids: [id],
      workerId: "b4e128f2-c057-43e9-bf32-7b0e30cc2cf2",
    });
    expect(concurrent.claimed).toBe(0);

    await database!
      .update(authEmailOutbox)
      .set({
        claimGeneration: 2,
        leaseOwner: "replacement-worker",
        leaseExpiresAt: new Date(0),
      })
      .where(eq(authEmailOutbox.id, id));
    releaseProvider();
    expect(await first).toMatchObject({
      claimed: 1,
      completed: 0,
      deferred: 1,
    });

    const retrySender: EmailSender = {
      send: async (_message, options) => {
        idempotencyKeys.push(options?.idempotencyKey ?? "");
        return { id: "retry-provider-id" };
      },
    };
    expect(
      await runAuthEmailOutboxOnce({
        database: database!,
        emailSender: retrySender,
        encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
        ids: [id],
        workerId: "c4e128f2-c057-43e9-bf32-7b0e30cc2cf3",
      }),
    ).toMatchObject({ claimed: 1, completed: 1 });
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);

    await database!
      .update(authEmailOutbox)
      .set({ updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
      .where(eq(authEmailOutbox.id, id));
    expect(
      await cleanupAuthEmailOutbox({ database: database!, limit: 25 }),
    ).toBe(1);
    expect(
      await database!
        .select({ id: authEmailOutbox.id })
        .from(authEmailOutbox)
        .where(eq(authEmailOutbox.id, id)),
    ).toEqual([]);
  });

  it("aborts a black-holed provider before scheduling an idempotent retry", async () => {
    const queued = createAuthEmailOutboxSender({
      authSecret: testAdminEnv.AUTH_SECRET,
      database: database!,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
    });
    await queued.sender.send({
      to: "abort-provider@example.test",
      subject: "Verify your Humans email",
      text: "https://humans.example.test/verify?token=abort-provider-secret",
    });
    const id = queued.queuedIds[0]!;
    let activeProviderCalls = 0;
    let observedAbort = false;
    const blackHoledSender = new ResendEmailSender(
      "provider-api-key",
      "Humans <humans@example.test>",
      "https://api.resend.test",
      (_url, init) => {
        activeProviderCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              activeProviderCalls -= 1;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      },
    );

    const failed = await runAuthEmailOutboxOnce({
      database: database!,
      deliveryTimeoutMs: 20,
      emailSender: blackHoledSender,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      ids: [id],
    });
    expect(failed).toMatchObject({ claimed: 1, completed: 0, deferred: 1 });
    expect(observedAbort).toBe(true);
    expect(activeProviderCalls).toBe(0);
    const [retryable] = await database!
      .select()
      .from(authEmailOutbox)
      .where(eq(authEmailOutbox.id, id));
    expect(retryable).toMatchObject({
      attemptCount: 1,
      errorCode: "delivery_unavailable",
      state: "queued",
    });

    await database!
      .update(authEmailOutbox)
      .set({ scheduledAt: new Date(0) })
      .where(eq(authEmailOutbox.id, id));
    const retriedKeys: string[] = [];
    await runAuthEmailOutboxOnce({
      database: database!,
      emailSender: {
        send: async (_message, options) => {
          retriedKeys.push(options?.idempotencyKey ?? "");
          return { id: "retry-provider-id" };
        },
      },
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      ids: [id],
    });
    expect(retriedKeys).toEqual([retryable!.idempotencyKey]);
  });

  it("keeps exact-ID drains free of retention work and bounds concurrent cleanup", async () => {
    const queued = createAuthEmailOutboxSender({
      authSecret: testAdminEnv.AUTH_SECRET,
      database: database!,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
    });
    for (let index = 0; index < 30; index += 1) {
      await queued.sender.send({
        to: `retention-${index}@example.test`,
        subject: "Verify your Humans email",
        text: `https://humans.example.test/verify?token=retention-${index}`,
      });
    }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await database!
      .update(authEmailOutbox)
      .set({ state: "completed", completedAt: old, updatedAt: old })
      .where(inArray(authEmailOutbox.id, queued.queuedIds));

    const exact = createAuthEmailOutboxSender({
      authSecret: testAdminEnv.AUTH_SECRET,
      database: database!,
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
    });
    await exact.sender.send({
      to: "exact-drain@example.test",
      subject: "Verify your Humans email",
      text: "https://humans.example.test/verify?token=exact-drain",
    });
    await runAuthEmailOutboxOnce({
      database: database!,
      emailSender: new TestEmailSender(),
      encryptionKey: testAdminEnv.AUTH_ENCRYPTION_KEY,
      ids: exact.queuedIds,
    });
    expect(
      await database!
        .select({ id: authEmailOutbox.id })
        .from(authEmailOutbox)
        .where(inArray(authEmailOutbox.id, queued.queuedIds)),
    ).toHaveLength(30);

    const deleted = await Promise.all([
      cleanupAuthEmailOutbox({ database: database!, limit: 20 }),
      cleanupAuthEmailOutbox({ database: database!, limit: 20 }),
    ]);
    expect(deleted.every((count) => count <= 20)).toBe(true);
    expect(deleted.reduce((sum, count) => sum + count, 0)).toBe(30);
    expect(
      await database!
        .select({ id: authEmailOutbox.id })
        .from(authEmailOutbox)
        .where(inArray(authEmailOutbox.id, queued.queuedIds)),
    ).toEqual([]);
  });

  it("normalizes valid usernames and rejects invalid usernames", async () => {
    expect(
      (
        await signUp(runtime, emailSender, {
          email: "normal@example.test",
          username: "Normal_User",
        })
      ).status,
    ).toBe(200);
    const [normal] = await database!
      .select({ username: users.username })
      .from(users)
      .where(eq(users.email, "normal@example.test"));
    expect(normal?.username).toBe("normal_user");

    const invalid = await authRequest(
      runtime.handler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Invalid",
          email: "invalid@example.test",
          username: "_not-valid",
          displayUsername: "_not-valid",
          password: accountPassword,
        },
      },
    );
    expect(invalid.status).toBe(400);
  });

  it("requires verified email for email and username sign-in", async () => {
    await signUp(runtime, emailSender, {
      email: "unverified@example.test",
      username: "UnverifiedUser",
    });
    const byEmail = await authRequest(
      runtime.handler,
      "/api/auth/sign-in/email",
      {
        body: { email: "unverified@example.test", password: accountPassword },
      },
    );
    const byUsername = await authRequest(
      runtime.handler,
      "/api/auth/sign-in/username",
      {
        body: { username: "UNVERIFIEDUSER", password: accountPassword },
      },
    );
    expect(byEmail.status).toBe(403);
    expect(byUsername.status).toBe(403);
    expect(
      emailSender.messages.filter((message) => /verify/i.test(message.subject)),
    ).toHaveLength(3);
  });

  it("keeps duplicate-email signup response shape indistinguishable", async () => {
    const first = await signUp(runtime, emailSender, {
      email: "duplicate@example.test",
      username: "FirstUsername",
    });
    const firstBody = await responseJson(first);
    const duplicate = await authRequest(
      runtime.handler,
      "/api/auth/sign-up/email",
      {
        body: {
          name: "Different Name",
          email: "duplicate@example.test",
          username: "AnotherUsername",
          displayUsername: "AnotherUsername",
          password: accountPassword,
        },
      },
    );
    const duplicateBody = await responseJson(duplicate);
    expect(duplicate.status).toBe(first.status);
    expect(responseShape(duplicateBody)).toEqual(responseShape(firstBody));
  });

  it("shares bounded PostgreSQL rate limits for signup and recovery", async () => {
    const secondRuntime = createHumansAuth({
      database: database!,
      emailSender,
      securityLogger: {
        log: (event) => securityEvents.push(event),
      },
      settings: testAdminEnv,
    });
    for (let index = 0; index < 5; index += 1) {
      const response = await authRequest(
        (index % 2 === 0 ? runtime : secondRuntime).handler,
        "/api/auth/sign-up/email",
        {
          body: {
            name: `Rate User ${index}`,
            email: `rate-user-${index}@example.test`,
            username: `RateUser${index}`,
            displayUsername: `RateUser${index}`,
            password: accountPassword,
          },
        },
      );
      expect(response.status).toBe(200);
    }
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/sign-up/email", {
          body: {
            name: "Rate User Limited",
            email: "rate-user-limited@example.test",
            username: "RateUserLimited",
            displayUsername: "RateUserLimited",
            password: accountPassword,
          },
        })
      ).status,
    ).toBe(429);

    for (let index = 0; index < 5; index += 1) {
      const response = await authRequest(
        (index % 2 === 0 ? secondRuntime : runtime).handler,
        "/api/auth/request-password-reset",
        {
          body: {
            email: `missing-rate-${index}@example.test`,
            redirectTo: "/reset-password",
          },
        },
      );
      expect(response.status).toBe(200);
    }
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/request-password-reset", {
          body: {
            email: "missing-rate-limited@example.test",
            redirectTo: "/reset-password",
          },
        })
      ).status,
    ).toBe(429);
    expect(emailSender.messages).toHaveLength(5);
  });

  it("delivers verification and reset links without logging action credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await signUp(runtime, emailSender, {
        email: "mail@example.test",
        username: "MailUser",
      });
      const verificationUrl = emailUrl(emailSender, /verify/i);
      await verifyLatestEmail(runtime, emailSender);
      const reset = await authRequest(
        runtime.handler,
        "/api/auth/request-password-reset",
        {
          body: {
            email: "mail@example.test",
            redirectTo: `${testAdminEnv.NEXT_PUBLIC_APP_URL}/reset-password`,
          },
        },
      );
      expect(reset.status).toBe(200);
      const resetUrl = emailUrl(emailSender, /reset/i);
      const verificationToken = actionCredential(verificationUrl);
      const resetToken = actionCredential(resetUrl);
      const logs = JSON.stringify([log.mock.calls, error.mock.calls]);
      expect(logs).not.toContain(verificationToken);
      expect(logs).not.toContain(resetToken);
      expect(logs).not.toContain(verificationUrl);
      expect(logs).not.toContain(resetUrl);
      expect(logs).not.toContain(accountPassword);

      const unintendedPersistence = JSON.stringify({
        apiKeys: await database!.select().from(apiKeys),
        invitations: await database!.select().from(invitations),
        sessions: await database!.select().from(sessions),
        twoFactors: await database!.select().from(twoFactors),
        users: await database!.select().from(users),
      });
      expect(unintendedPersistence).not.toContain(verificationUrl);
      expect(unintendedPersistence).not.toContain(resetUrl);
      expect(unintendedPersistence).not.toContain(verificationToken);
      expect(unintendedPersistence).not.toContain(resetToken);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps recovery enumeration-safe, rejects unsafe returns, and revokes sessions on one-time reset", async () => {
    const first = await createVerifiedUser(runtime, emailSender, {
      email: "recovery@example.test",
      username: "RecoveryUser",
    });
    const secondJar = new CookieJar();
    await authRequest(runtime.handler, "/api/auth/sign-in/email", {
      body: { email: "recovery@example.test", password: accountPassword },
      jar: secondJar,
    });

    const known = await authRequest(
      runtime.handler,
      "/api/auth/request-password-reset",
      {
        body: {
          email: "recovery@example.test",
          redirectTo: "/reset-password",
        },
      },
    );
    const unknown = await authRequest(
      runtime.handler,
      "/api/auth/request-password-reset",
      {
        body: {
          email: "missing-recovery@example.test",
          redirectTo: "/reset-password",
        },
      },
    );
    expect(unknown.status).toBe(known.status);
    expect(responseShape(await responseJson(unknown))).toEqual(
      responseShape(await responseJson(known)),
    );
    const recoveryEvents = securityEvents.filter(
      ({ event }) => event === "auth.recovery.requested",
    );
    expect(recoveryEvents).toHaveLength(2);
    for (const event of recoveryEvents) {
      expect(event).toMatchObject({
        event: "auth.recovery.requested",
        severity: "info",
      });
      expect(event).toHaveProperty(
        "requestId",
        expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      );
    }
    expect(JSON.stringify(securityEvents)).not.toContain(
      "recovery@example.test",
    );
    const resetUrl = new URL(emailUrl(emailSender, /reset/i));
    expect(resetUrl.origin).toBe(
      new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin,
    );
    expect(resetUrl.pathname).toMatch(/^\/api\/auth\/reset-password\//u);
    expect(resetUrl.searchParams.get("callbackURL")).toBe("/reset-password");
    const token = actionCredential(resetUrl.toString());

    const unsafe = await authRequest(
      runtime.handler,
      "/api/auth/request-password-reset",
      {
        body: {
          email: "recovery@example.test",
          redirectTo: "https://attacker.example/reset",
        },
      },
    );
    expect(unsafe.status).toBe(403);

    const newPassword = "New recovery password! 2026 secure";
    const reset = await authRequest(
      runtime.handler,
      "/api/auth/reset-password",
      {
        body: { newPassword, token },
      },
    );
    expect(reset.status).toBe(200);
    for (const jar of [first.jar, secondJar]) {
      expect(
        await responseJson(
          await authRequest(runtime.handler, "/api/auth/get-session", { jar }),
        ),
      ).toBeNull();
    }
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/reset-password", {
          body: { newPassword: "Another secure password! 2026", token },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/sign-in/email", {
          body: { email: "recovery@example.test", password: newPassword },
        })
      ).status,
    ).toBe(200);

    await authRequest(runtime.handler, "/api/auth/request-password-reset", {
      body: { email: "recovery@example.test", redirectTo: "/reset-password" },
    });
    const expiredToken = actionCredential(emailUrl(emailSender, /reset/i));
    await database!
      .update(verifications)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(verifications.identifier, `reset-password:${expiredToken}`));
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/reset-password", {
          body: {
            newPassword: "Expired token password! 2026",
            token: expiredToken,
          },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("rejects cookie-authenticated mutations without a trusted browser origin", async () => {
    const { jar } = await createVerifiedUser(runtime, emailSender, {
      email: "origin@example.test",
      username: "OriginUser",
    });
    const cookieBefore = jar.toString();

    const browserHeaderCases: readonly Record<string, string>[] = [
      {},
      { origin: "not a valid origin" },
      {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    ];
    for (const browserHeaders of browserHeaderCases) {
      const headers = new Headers({
        "content-type": "application/json",
        ...browserHeaders,
      });
      jar.apply(headers);
      const response = await runtime.handler(
        new Request(
          new URL("/api/auth/sign-out", testAdminEnv.NEXT_PUBLIC_APP_URL),
          { body: "{}", headers, method: "POST" },
        ),
      );
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(jar.toString()).toBe(cookieBefore);
    }

    const session = await authRequest(
      runtime.handler,
      "/api/auth/get-session",
      {
        jar,
      },
    );
    expect(await responseJson(session)).not.toBeNull();
  });

  it("sets production session cookies HttpOnly, SameSite, and Secure", async () => {
    const secureRuntime = createHumansAuth({
      database: database!,
      emailSender,
      settings: { ...testAdminEnv, AUTH_SECURE_COOKIES: true },
    });
    await signUp(secureRuntime, emailSender, {
      email: "secure-cookie@example.test",
      username: "SecureCookieUser",
    });
    await verifyLatestEmail(secureRuntime, emailSender);

    const signIn = await authRequest(
      secureRuntime.handler,
      "/api/auth/sign-in/email",
      {
        body: {
          email: "secure-cookie@example.test",
          password: accountPassword,
        },
      },
    );
    expect(signIn.status).toBe(200);
    const sessionCookie = signIn.headers
      .getSetCookie()
      .find((cookie) => /session_token/iu.test(cookie));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/;\s*HttpOnly(?:;|$)/iu);
    expect(sessionCookie).toMatch(/;\s*SameSite=Lax(?:;|$)/iu);
    expect(sessionCookie).toMatch(/;\s*Secure(?:;|$)/iu);
  });

  it("outer-encrypts TOTP and backup codes, completes 2FA, and rotates on disable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { jar, userId } = await createVerifiedUser(runtime, emailSender, {
      email: "twofactor@example.test",
      username: "TwoFactorUser",
    });

    const missingPassword = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/enable",
      { body: {}, jar },
    );
    expect(missingPassword.status).toBe(400);

    const enabled = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/enable",
      {
        body: { password: accountPassword },
        jar,
      },
    );
    expect(enabled.status).toBe(200);
    const enrollment = await responseJson<{
      backupCodes: string[];
      totpURI: string;
    }>(enabled);
    expect(enrollment.totpURI).toMatch(/^otpauth:\/\/totp\//u);
    expect(enrollment.backupCodes).toHaveLength(10);

    const [stored] = await database!
      .select()
      .from(twoFactors)
      .where(eq(twoFactors.userId, userId));
    const innerSecret = await decryptAuthMaterial(
      stored!.secret,
      testAdminEnv.AUTH_ENCRYPTION_KEY,
    );
    const innerBackupCodes = await decryptAuthMaterial(
      stored!.backupCodes,
      testAdminEnv.AUTH_ENCRYPTION_KEY,
    );
    const rawSecret = new URL(enrollment.totpURI).searchParams.get("secret")!;
    expect(stored!.secret).not.toBe(rawSecret);
    expect(stored!.secret).not.toBe(innerSecret);
    expect(innerSecret).not.toBe(rawSecret);
    expect(stored!.backupCodes).not.toBe(innerBackupCodes);
    expect(JSON.parse(innerBackupCodes)).toEqual(enrollment.backupCodes);
    for (const code of enrollment.backupCodes) {
      expect(stored!.backupCodes).not.toContain(code);
    }
    const [beforeVerification] = await database!
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId));
    expect(beforeVerification?.enabled).not.toBe(true);

    const verify = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/verify-totp",
      {
        body: { code: currentTotp(enrollment.totpURI) },
        jar,
      },
    );
    expect(verify.status).toBe(200);
    const [afterVerification] = await database!
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId));
    expect(afterVerification?.enabled).toBe(true);

    await authRequest(runtime.handler, "/api/auth/sign-out", { body: {}, jar });
    const challengeJar = new CookieJar();
    const signin = await authRequest(
      runtime.handler,
      "/api/auth/sign-in/email",
      {
        body: { email: "twofactor@example.test", password: accountPassword },
        jar: challengeJar,
      },
    );
    expect(await responseJson(signin)).toMatchObject({
      twoFactorRedirect: true,
    });
    const preliminary = await authRequest(
      runtime.handler,
      "/api/auth/get-session",
      {
        jar: challengeJar,
      },
    );
    expect(await responseJson(preliminary)).toBeNull();
    const challenge = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/verify-totp",
      {
        body: { code: currentTotp(enrollment.totpURI) },
        jar: challengeJar,
      },
    );
    expect(challenge.status).toBe(200);
    const authenticated = await authRequest(
      runtime.handler,
      "/api/auth/get-session",
      { jar: challengeJar },
    );
    expect(await responseJson(authenticated)).not.toBeNull();

    const otherJar = new CookieJar();
    await authRequest(runtime.handler, "/api/auth/sign-in/email", {
      body: { email: "twofactor@example.test", password: accountPassword },
      jar: otherJar,
    });
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/two-factor/verify-totp", {
          body: { code: currentTotp(enrollment.totpURI) },
          jar: otherJar,
        })
      ).status,
    ).toBe(200);

    await expect(
      changeTwoFactorStateAtomically({
        action: "disable",
        database: database!,
        password: accountPassword,
        userId,
      }),
    ).resolves.toBe("disabled");
    expect(
      await database!
        .select()
        .from(twoFactors)
        .where(eq(twoFactors.userId, userId)),
    ).toHaveLength(0);
    expect(
      await database!
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId)),
    ).toHaveLength(0);
    for (const revokedJar of [challengeJar, otherJar]) {
      expect(
        await responseJson(
          await authRequest(runtime.handler, "/api/auth/get-session", {
            jar: revokedJar,
          }),
        ),
      ).toBeNull();
    }
    const logs = JSON.stringify([log.mock.calls, error.mock.calls]);
    expect(logs).not.toContain(enrollment.totpURI);
    expect(logs).not.toContain(rawSecret);
    expect(logs).not.toContain(accountPassword);
    for (const code of enrollment.backupCodes) expect(logs).not.toContain(code);
  });

  it("consumes one backup code atomically and regeneration invalidates old codes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { jar } = await createVerifiedUser(runtime, emailSender, {
      email: "backup@example.test",
      username: "BackupUser",
    });
    const enable = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/enable",
      {
        body: { password: accountPassword },
        jar,
      },
    );
    const enrollment = await responseJson<{
      backupCodes: string[];
      totpURI: string;
    }>(enable);
    await authRequest(runtime.handler, "/api/auth/two-factor/verify-totp", {
      body: { code: currentTotp(enrollment.totpURI) },
      jar,
    });
    await authRequest(runtime.handler, "/api/auth/sign-out", { body: {}, jar });

    const challengeJar = new CookieJar();
    await authRequest(runtime.handler, "/api/auth/sign-in/email", {
      body: { email: "backup@example.test", password: accountPassword },
      jar: challengeJar,
    });
    const cookie = challengeJar.toString();
    const code = enrollment.backupCodes[0]!;
    const attempts = await Promise.all(
      [new CookieJar(cookie), new CookieJar(cookie)].map((attemptJar) =>
        authRequest(
          runtime.handler,
          "/api/auth/two-factor/verify-backup-code",
          {
            body: { code },
            jar: attemptJar,
          },
        ),
      ),
    );
    expect(attempts.filter((response) => response.status === 200)).toHaveLength(
      1,
    );

    const fullJar = new CookieJar();
    await authRequest(runtime.handler, "/api/auth/sign-in/email", {
      body: { email: "backup@example.test", password: accountPassword },
      jar: fullJar,
    });
    await authRequest(runtime.handler, "/api/auth/two-factor/verify-totp", {
      body: { code: currentTotp(enrollment.totpURI) },
      jar: fullJar,
    });
    const regenerated = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/generate-backup-codes",
      { body: { password: accountPassword }, jar: fullJar },
    );
    const replacement = await responseJson<{ backupCodes: string[] }>(
      regenerated,
    );
    expect(replacement.backupCodes).toHaveLength(10);
    expect(replacement.backupCodes).not.toEqual(enrollment.backupCodes);

    await authRequest(runtime.handler, "/api/auth/sign-out", {
      body: {},
      jar: fullJar,
    });
    const oldCodeJar = new CookieJar();
    await authRequest(runtime.handler, "/api/auth/sign-in/email", {
      body: { email: "backup@example.test", password: accountPassword },
      jar: oldCodeJar,
    });
    const oldCode = await authRequest(
      runtime.handler,
      "/api/auth/two-factor/verify-backup-code",
      { body: { code: enrollment.backupCodes[1]! }, jar: oldCodeJar },
    );
    expect(oldCode.status).toBe(401);
    const logs = JSON.stringify([log.mock.calls, error.mock.calls]);
    expect(logs).not.toContain(enrollment.totpURI);
    expect(logs).not.toContain(accountPassword);
    for (const code of [
      ...enrollment.backupCodes,
      ...replacement.backupCodes,
    ]) {
      expect(logs).not.toContain(code);
    }
  });

  it("provisions an atomic workspace and durable owner principal", async () => {
    const { jar, userId } = await createVerifiedUser(runtime, emailSender, {
      email: "provision@example.test",
      username: "ProvisionUser",
    });
    const identity = await provisionWorkspace(database!, {
      userId,
      name: "Atomic Workspace",
      slug: `atomic-${newId()}`,
    });
    const [member] = await database!
      .select()
      .from(members)
      .where(eq(members.id, identity.memberId));
    const [principal] = await database!
      .select()
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.id, identity.principalId));
    expect(member).toMatchObject({
      workspaceId: identity.workspaceId,
      organizationId: identity.organizationId,
      userId,
      role: "owner",
    });
    expect(principal).toMatchObject({
      workspaceId: identity.workspaceId,
      userId,
      memberIdSnapshot: identity.memberId,
      principalType: "user",
    });

    const before = {
      organizations: await database!.select().from(organizations),
      workspaces: await database!.select().from(workspaces),
      members: await database!.select().from(members),
    };

    const publicCreate = await authRequest(
      runtime.handler,
      "/api/auth/organization/create",
      {
        body: { name: "Unsafe", slug: `unsafe-${newId()}` },
        jar,
      },
    );
    expect(publicCreate.status).toBe(403);
    expect(await database!.select().from(organizations)).toEqual(
      before.organizations,
    );
    expect(await database!.select().from(workspaces)).toEqual(
      before.workspaces,
    );
    expect(await database!.select().from(members)).toEqual(before.members);
  });

  it("enforces invitation recipient, verification, state, expiry, and exact roles", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const owner = await createOwner(runtime, emailSender);
    for (const role of ["member", "unknown", "viewer,admin"]) {
      const rejected = await authRequest(
        runtime.handler,
        "/api/auth/organization/invite-member",
        {
          body: {
            email: `${role.replaceAll(/[^a-z]/giu, "-")}@example.test`,
            role,
            organizationId: owner.organizationId,
          },
          jar: owner.jar,
        },
      );
      expect(rejected.status).toBe(400);
    }

    const target = await createVerifiedUser(runtime, emailSender, {
      email: "invitee@example.test",
      username: "InviteeUser",
    });
    const wrong = await createVerifiedUser(runtime, emailSender, {
      email: "wrong-recipient@example.test",
      username: "WrongRecipient",
    });
    const invite = await authRequest(
      runtime.handler,
      "/api/auth/organization/invite-member",
      {
        body: {
          email: "invitee@example.test",
          role: "analyst",
          organizationId: owner.organizationId,
        },
        jar: owner.jar,
      },
    );
    expect(invite.status).toBe(200);
    const invitation = await responseJson<{ id: string }>(invite);
    const invitationUrl = emailUrl(emailSender, /invitation/i);
    expect(new URL(invitationUrl).searchParams.get("id")).toBe(invitation.id);
    expect(invitationUrl).not.toContain("invitee@example.test");
    const invitationLogs = JSON.stringify([log.mock.calls, error.mock.calls]);
    expect(invitationLogs).not.toContain(invitation.id);
    expect(invitationLogs).not.toContain(invitationUrl);

    const wrongRecipient = await authRequest(
      runtime.handler,
      "/api/auth/organization/accept-invitation",
      { body: { invitationId: invitation.id }, jar: wrong.jar },
    );
    expect(wrongRecipient.status).toBe(403);

    await database!
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, target.userId));
    const unverified = await authRequest(
      runtime.handler,
      "/api/auth/organization/accept-invitation",
      { body: { invitationId: invitation.id }, jar: target.jar },
    );
    expect(unverified.status).toBe(403);
    await database!
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, target.userId));

    await database!
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(invitations.id, invitation.id));
    const expired = await authRequest(
      runtime.handler,
      "/api/auth/organization/accept-invitation",
      { body: { invitationId: invitation.id }, jar: target.jar },
    );
    expect(expired.status).toBe(400);
    await database!
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() + 60_000), status: "cancelled" })
      .where(eq(invitations.id, invitation.id));
    const cancelled = await authRequest(
      runtime.handler,
      "/api/auth/organization/accept-invitation",
      { body: { invitationId: invitation.id }, jar: target.jar },
    );
    expect(cancelled.status).toBe(400);

    await database!
      .update(invitations)
      .set({ status: "pending" })
      .where(eq(invitations.id, invitation.id));
    const concurrentAcceptances = await Promise.allSettled([
      acceptInvitationAtomically({
        database: database!,
        invitationId: invitation.id,
        userId: target.userId,
      }),
      acceptInvitationAtomically({
        database: database!,
        invitationId: invitation.id,
        userId: target.userId,
      }),
    ]);
    expect(
      concurrentAcceptances.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const targetMemberships = await database!
      .select()
      .from(members)
      .where(
        and(
          eq(members.organizationId, owner.organizationId),
          eq(members.userId, target.userId),
        ),
      );
    expect(targetMemberships).toHaveLength(1);
    const [membership] = targetMemberships;
    expect(membership).toMatchObject({
      workspaceId: owner.workspaceId,
      role: "analyst",
    });
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, invitation.id)),
    ).toEqual([{ status: "accepted" }]);

    const rollbackFixtureRuntime = createHumansAuth({
      database: database!,
      emailSender,
      rateLimitEnabled: false,
      settings: testAdminEnv,
    });
    for (const [index, failureStep] of [
      "membership_created",
      "invitation_accepted",
    ].entries()) {
      const rollbackTarget = await createVerifiedUser(
        rollbackFixtureRuntime,
        emailSender,
        {
          email: `invite-rollback-${index}@example.test`,
          username: `InviteRollback${index}`,
        },
      );
      const rollbackInvitationId = newId();
      await database!.insert(invitations).values({
        id: rollbackInvitationId,
        organizationId: owner.organizationId,
        email: `invite-rollback-${index}@example.test`,
        role: "viewer",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        inviterId: owner.userId,
      });
      await expect(
        acceptInvitationAtomically({
          afterStep: (step) => {
            if (step === failureStep) throw new Error("injected failure");
          },
          database: database!,
          invitationId: rollbackInvitationId,
          userId: rollbackTarget.userId,
        }),
      ).rejects.toThrow("injected failure");
      expect(
        await database!
          .select()
          .from(members)
          .where(eq(members.userId, rollbackTarget.userId)),
      ).toEqual([]);
      expect(
        await database!
          .select({ status: invitations.status })
          .from(invitations)
          .where(eq(invitations.id, rollbackInvitationId)),
      ).toEqual([{ status: "pending" }]);
    }

    for (const role of ["member", "viewer,admin"]) {
      const update = await authRequest(
        runtime.handler,
        "/api/auth/organization/update-member-role",
        {
          body: {
            memberId: membership!.id,
            organizationId: owner.organizationId,
            role,
          },
          jar: owner.jar,
        },
      );
      expect(update.status).toBe(400);
    }
    const completedWorkflowLogs = JSON.stringify([
      log.mock.calls,
      error.mock.calls,
    ]);
    expect(completedWorkflowLogs).not.toContain(invitation.id);
    expect(completedWorkflowLogs).not.toContain(invitationUrl);
  });

  it("serializes invitation acceptance behind workspace archive/delete state", async () => {
    const owner = await createOwner(runtime, emailSender);
    const target = await createVerifiedUser(runtime, emailSender, {
      email: "workspace-race@example.test",
      username: "WorkspaceRace",
    });
    const invitationId = newId();
    await database!.insert(invitations).values({
      id: invitationId,
      organizationId: owner.organizationId,
      email: "workspace-race@example.test",
      role: "viewer",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: owner.userId,
    });

    let releaseArchive!: () => void;
    let archiveLocked!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      archiveLocked = resolve;
    });
    const archive = database!.transaction(async (transaction) => {
      await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, owner.workspaceId))
        .for("update");
      archiveLocked();
      await archiveGate;
      await transaction
        .update(workspaces)
        .set({ state: "archived", updatedAt: new Date() })
        .where(eq(workspaces.id, owner.workspaceId));
    });
    await locked;
    const acceptance = acceptInvitationAtomically({
      database: database!,
      invitationId,
      userId: target.userId,
    });
    releaseArchive();
    await archive;
    await expect(acceptance).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(
      await database!
        .select()
        .from(members)
        .where(eq(members.userId, target.userId)),
    ).toEqual([]);
    expect(
      await database!
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, invitationId)),
    ).toEqual([{ status: "pending" }]);

    await database!
      .update(workspaces)
      .set({ deletedAt: new Date(), state: "active" })
      .where(eq(workspaces.id, owner.workspaceId));
    await expect(
      acceptInvitationAtomically({
        database: database!,
        invitationId,
        userId: target.userId,
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(
      await database!
        .select()
        .from(members)
        .where(eq(members.userId, target.userId)),
    ).toEqual([]);

    await database!
      .update(workspaces)
      .set({ deletedAt: null, state: "active" })
      .where(eq(workspaces.id, owner.workspaceId));
    await expect(
      acceptInvitationAtomically({
        afterStep: (step) => {
          if (step === "invitation_locked") throw new Error("rollback-race");
        },
        database: database!,
        invitationId,
        userId: target.userId,
      }),
    ).rejects.toThrow("rollback-race");
    expect(
      await database!
        .select()
        .from(members)
        .where(eq(members.userId, target.userId)),
    ).toEqual([]);
  });

  it("prevents admins from granting or taking the owner role", async () => {
    const owner = await createOwner(runtime, emailSender);
    const admin = await createVerifiedUser(runtime, emailSender, {
      email: "boundary-admin@example.test",
      username: "BoundaryAdmin",
    });
    const viewer = await createVerifiedUser(runtime, emailSender, {
      email: "boundary-viewer@example.test",
      username: "BoundaryViewer",
    });
    const adminMemberId = newId();
    const viewerMemberId = newId();
    await database!.insert(members).values([
      {
        id: adminMemberId,
        organizationId: owner.organizationId,
        userId: admin.userId,
        role: "admin",
        createdAt: new Date(),
        workspaceId: owner.workspaceId,
      },
      {
        id: viewerMemberId,
        organizationId: owner.organizationId,
        userId: viewer.userId,
        role: "viewer",
        createdAt: new Date(),
        workspaceId: owner.workspaceId,
      },
    ]);
    const setActive = await authRequest(
      runtime.handler,
      "/api/auth/organization/set-active",
      {
        body: { organizationId: owner.organizationId },
        jar: admin.jar,
      },
    );
    expect(setActive.status).toBe(200);

    const inviteCountBefore = await database!.select().from(invitations);
    const membersBefore = await database!.select().from(members);

    const inviteOwner = await authRequest(
      runtime.handler,
      "/api/auth/organization/invite-member",
      {
        body: {
          email: "new-owner@example.test",
          organizationId: owner.organizationId,
          role: "owner",
        },
        jar: admin.jar,
      },
    );
    expect(inviteOwner.status).toBe(403);

    const promoteViewer = await authRequest(
      runtime.handler,
      "/api/auth/organization/update-member-role",
      {
        body: {
          memberId: viewerMemberId,
          organizationId: owner.organizationId,
          role: "owner",
        },
        jar: admin.jar,
      },
    );
    expect(promoteViewer.status).toBe(403);

    const demoteOwner = await authRequest(
      runtime.handler,
      "/api/auth/organization/update-member-role",
      {
        body: {
          memberId: owner.memberId,
          organizationId: owner.organizationId,
          role: "viewer",
        },
        jar: admin.jar,
      },
    );
    expect(demoteOwner.status).toBe(403);

    const removeOwner = await authRequest(
      runtime.handler,
      "/api/auth/organization/remove-member",
      {
        body: {
          memberIdOrEmail: owner.memberId,
          organizationId: owner.organizationId,
        },
        jar: admin.jar,
      },
    );
    expect(removeOwner.status).toBe(400);

    expect(await database!.select().from(invitations)).toEqual(
      inviteCountBefore,
    );
    expect(await database!.select().from(members)).toEqual(membersBefore);
  });

  it("derives member tenancy and rejects stale active organizations", async () => {
    const owner = await createOwner(runtime, emailSender);
    const active = await resolveActiveWorkspace({
      auth: runtime,
      database: database!,
      headers: jarHeaders(owner.jar),
    });
    expect(active).toMatchObject({
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      role: "owner",
    });

    await database!
      .update(members)
      .set({ workspaceId: newId() })
      .where(eq(members.id, owner.memberId));
    const [derived] = await database!
      .select({ workspaceId: members.workspaceId })
      .from(members)
      .where(eq(members.id, owner.memberId));
    expect(derived?.workspaceId).toBe(owner.workspaceId);

    await database!.delete(members).where(eq(members.id, owner.memberId));
    await expect(
      resolveActiveWorkspace({
        auth: runtime,
        database: database!,
        headers: jarHeaders(owner.jar),
      }),
    ).rejects.toThrow("Active workspace membership is required");
  });

  it("provisions scoped organization keys raw-once with trusted tenant derivation", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const owner = await createOwner(runtime, emailSender);
    await expect(
      provisionOrganizationApiKey({
        auth: runtime,
        database: database!,
        headers: jarHeaders(owner.jar),
        name: "Empty permission key",
        permissions: { person: [] },
      }),
    ).rejects.toThrow("At least one API key permission is required");
    const created = await provisionOrganizationApiKey({
      auth: runtime,
      database: database!,
      headers: jarHeaders(owner.jar),
      name: "Read-only integration",
      permissions: { person: ["read"], fact: ["read"] },
    });
    expect(created.key).toMatch(/^hum_/u);
    const rawKey = created.key;
    const [stored] = await database!
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));
    expect(stored).toMatchObject({
      configId: "organization",
      referenceId: owner.organizationId,
      workspaceId: owner.workspaceId,
    });
    expect(stored!.key).not.toBe(rawKey);
    expect(stored!.key).not.toContain(rawKey);
    const keyLogs = JSON.stringify([log.mock.calls, error.mock.calls]);
    expect(keyLogs).not.toContain(rawKey);

    const listed = await runtime.api.listApiKeys({
      headers: jarHeaders(owner.jar),
      query: {
        configId: "organization",
        organizationId: owner.organizationId,
      },
    });
    const fetched = await runtime.api.getApiKey({
      headers: jarHeaders(owner.jar),
      query: { configId: "organization", id: created.id },
    });
    expect(JSON.stringify(listed)).not.toContain(rawKey);
    expect(JSON.stringify(fetched)).not.toContain(rawKey);
    expect(Object.hasOwn(fetched, "key")).toBe(false);

    await database!
      .update(apiKeys)
      .set({ workspaceId: newId() })
      .where(eq(apiKeys.id, created.id));
    const [derived] = await database!
      .select({ workspaceId: apiKeys.workspaceId })
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));
    expect(derived?.workspaceId).toBe(owner.workspaceId);

    const admin = await createVerifiedUser(runtime, emailSender, {
      email: "key-admin@example.test",
      username: "KeyAdmin",
    });
    const adminMemberId = newId();
    await database!.insert(members).values({
      id: adminMemberId,
      organizationId: owner.organizationId,
      userId: admin.userId,
      role: "admin",
      createdAt: new Date(),
      workspaceId: owner.workspaceId,
    });
    await ensureUserPrincipal(database!, {
      workspaceId: owner.workspaceId,
      memberId: adminMemberId,
      userId: admin.userId,
    });
    const setActive = await authRequest(
      runtime.handler,
      "/api/auth/organization/set-active",
      {
        body: { organizationId: owner.organizationId },
        jar: admin.jar,
      },
    );
    expect(setActive.status).toBe(200);

    await expect(
      provisionOrganizationApiKey({
        auth: runtime,
        database: database!,
        headers: jarHeaders(admin.jar),
        name: "Escalated",
        permissions: { workspace: ["purge"] },
      }),
    ).rejects.toThrow("API key permissions exceed the actor's authority");
  });

  it("never treats a provisioned API key as interactive account authority", async () => {
    const owner = await createOwner(runtime, emailSender);
    const created = await provisionOrganizationApiKey({
      auth: runtime,
      database: database!,
      headers: jarHeaders(owner.jar),
      name: "Non-interactive key",
      permissions: { person: ["read"] },
    });
    const sessionsBefore = await database!
      .select()
      .from(sessions)
      .where(eq(sessions.userId, owner.userId));

    const boundaryHandler = createAuthRouteHandlers(async () => ({
      POST: runtime.handler,
    })).POST;
    for (const [path, body] of [
      ["/api/auth/sign-out", {}],
      [
        "/api/auth/change-password",
        {
          currentPassword: accountPassword,
          newPassword: "Different password! 2026",
        },
      ],
      ["/api/auth/two-factor/enable", { password: accountPassword }],
      ["/api/auth/revoke-sessions", {}],
    ] as const) {
      const response = await authRequest(boundaryHandler, path, {
        body,
        headers: {
          authorization: `Bearer ${created.key}`,
          "x-api-key": created.key,
        },
        jar: owner.jar,
      });
      expect(response.status).toBe(403);
      await expect(responseJson(response)).resolves.toMatchObject({
        code: "AUTH_API_KEY_INTERACTIVE_FORBIDDEN",
      });
    }
    expect(
      await database!
        .select()
        .from(sessions)
        .where(eq(sessions.userId, owner.userId)),
    ).toEqual(sessionsBefore);
  });

  it("fails API keys closed when expired, disabled, deleted, or used for another workspace", async () => {
    const owner = await createOwner(runtime, emailSender);
    const created = await provisionOrganizationApiKey({
      auth: runtime,
      database: database!,
      headers: jarHeaders(owner.jar),
      name: "Lifecycle key",
      permissions: { person: ["read"] },
    });
    const valid = await verifyOrganizationApiKey({
      auth: runtime,
      database: database!,
      key: created.key,
      workspaceId: owner.workspaceId,
      requiredPermission: { resource: "person", action: "read" },
    });
    expect(valid.apiKeyId).toBe(created.id);
    await expect(
      verifyOrganizationApiKey({
        auth: runtime,
        database: database!,
        key: created.key,
        workspaceId: newId(),
        requiredPermission: { resource: "person", action: "read" },
      }),
    ).rejects.toThrow("API key is not valid for this workspace");

    await database!
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(apiKeys.id, created.id));
    await expect(
      verifyOrganizationApiKey({
        auth: runtime,
        database: database!,
        key: created.key,
        workspaceId: owner.workspaceId,
      }),
    ).rejects.toThrow("API key is invalid");
    await database!
      .update(apiKeys)
      .set({ expiresAt: null, enabled: false })
      .where(eq(apiKeys.id, created.id));
    await expect(
      verifyOrganizationApiKey({
        auth: runtime,
        database: database!,
        key: created.key,
        workspaceId: owner.workspaceId,
      }),
    ).rejects.toThrow("API key is invalid");
    await database!.delete(apiKeys).where(eq(apiKeys.id, created.id));
    await expect(
      verifyOrganizationApiKey({
        auth: runtime,
        database: database!,
        key: created.key,
        workspaceId: owner.workspaceId,
      }),
    ).rejects.toThrow("API key is invalid");
  });

  it("preserves immutable history through logout, offboarding, and API-key deletion", async () => {
    const owner = await createOwner(runtime, emailSender);
    const offboarded = await createVerifiedUser(runtime, emailSender, {
      email: "offboarded@example.test",
      username: "OffboardedUser",
    });
    const offboardedMemberId = newId();
    await database!.insert(members).values({
      id: offboardedMemberId,
      organizationId: owner.organizationId,
      userId: offboarded.userId,
      role: "contributor",
      createdAt: new Date(),
      workspaceId: owner.workspaceId,
    });
    const userPrincipalId = await ensureUserPrincipal(database!, {
      workspaceId: owner.workspaceId,
      memberId: offboardedMemberId,
      userId: offboarded.userId,
    });
    const createdKey = await provisionOrganizationApiKey({
      auth: runtime,
      database: database!,
      headers: jarHeaders(owner.jar),
      name: "Historical key",
      permissions: { person: ["read"] },
    });
    const apiKeyPrincipalId = await ensureApiKeyPrincipal(database!, {
      workspaceId: owner.workspaceId,
      apiKeyId: createdKey.id,
    });
    const [session] = await database!
      .select()
      .from(sessions)
      .where(eq(sessions.userId, offboarded.userId));
    const userAuditId = newId();
    const keyAuditId = newId();
    await database!.insert(auditEvents).values([
      {
        id: userAuditId,
        workspaceId: owner.workspaceId,
        actorUserId: offboarded.userId,
        sessionId: session!.id,
        action: "workspace.read",
        resourceKind: "workspace",
        requestId: newId(),
        outcome: "success",
      },
      {
        id: keyAuditId,
        workspaceId: owner.workspaceId,
        apiKeyId: createdKey.id,
        action: "person.read",
        resourceKind: "person",
        requestId: newId(),
        outcome: "success",
      },
    ]);

    const removedMember = await authRequest(
      runtime.handler,
      "/api/auth/organization/remove-member",
      {
        body: {
          memberIdOrEmail: offboardedMemberId,
          organizationId: owner.organizationId,
        },
        jar: owner.jar,
      },
    );
    expect(removedMember.status).toBe(200);
    const deletedKey = await authRequest(
      runtime.handler,
      "/api/auth/api-key/delete",
      {
        body: { configId: "organization", keyId: createdKey.id },
        jar: owner.jar,
      },
    );
    expect(deletedKey.status).toBe(200);
    expect(
      (
        await authRequest(runtime.handler, "/api/auth/sign-out", {
          body: {},
          jar: offboarded.jar,
        })
      ).status,
    ).toBe(200);
    expect(
      await database!
        .select()
        .from(sessions)
        .where(eq(sessions.id, session!.id)),
    ).toHaveLength(0);

    expect(
      await database!
        .select()
        .from(workspacePrincipals)
        .where(
          and(
            eq(workspacePrincipals.workspaceId, owner.workspaceId),
            eq(workspacePrincipals.id, userPrincipalId),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await database!
        .select()
        .from(workspacePrincipals)
        .where(eq(workspacePrincipals.id, apiKeyPrincipalId)),
    ).toHaveLength(1);
    expect(
      await database!
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.id, userAuditId)),
    ).toHaveLength(1);
    expect(
      await database!
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.id, keyAuditId)),
    ).toHaveLength(1);
    await expect(
      ensureUserPrincipal(database!, {
        workspaceId: owner.workspaceId,
        memberId: offboardedMemberId,
        userId: offboarded.userId,
      }),
    ).rejects.toThrow("Active workspace membership is required");
    await expect(
      ensureApiKeyPrincipal(database!, {
        workspaceId: owner.workspaceId,
        apiKeyId: createdKey.id,
      }),
    ).rejects.toThrow("Active API key is required");
  });

  it("keeps sensitive action material out of auth UI persistence and logging APIs", async () => {
    const source = await Promise.all(
      [
        "src/app/(auth)/accept-invitation/page.tsx",
        "src/app/(auth)/forgot-password/page.tsx",
        "src/app/(auth)/reset-password/page.tsx",
        "src/app/(auth)/sign-in/page.tsx",
        "src/app/(auth)/sign-up/page.tsx",
        "src/app/(auth)/two-factor/enroll/page.tsx",
        "src/app/(auth)/two-factor/enroll/two-factor-enrollment.tsx",
        "src/app/(auth)/two-factor/page.tsx",
        "src/modules/auth/auth.ts",
        "src/modules/auth/auth-client.ts",
        "src/lib/auth/config.ts",
      ].map(async (path) => readFile(path, "utf8")),
    );
    const joined = source.join("\n");
    expect(joined).not.toMatch(/localStorage|sessionStorage|viewBackupCodes/u);
    expect(joined).not.toMatch(/console\.(?:log|info|warn|error|debug)/u);
  });
});
