// @vitest-environment node

import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import {
  accounts,
  rateLimits,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@/db/schema/auth";
import {
  changeTwoFactorStateAtomically,
  type TwoFactorDisableStep,
} from "@/modules/auth/two-factor-lifecycle";
import {
  consumePasswordAttempt,
  TWO_FACTOR_PASSWORD_ATTEMPT_WINDOW_SECONDS,
} from "@/modules/auth/password-attempt-limiter";
import {
  createTestConnection,
  createTestDatabase,
  resetTestDatabase,
} from "../support/auth";

const connection = process.env.TEST_DATABASE_URL
  ? createTestConnection()
  : undefined;
const database = connection ? createTestDatabase(connection) : undefined;
const liveDescribe = connection ? describe : describe.skip;
const password = "Atomic two factor password! 2026";
const attemptSecret = "test-only-attempt-secret-".repeat(2);

async function seed(enabled = true) {
  const userId = newId();
  await database!.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    emailVerified: true,
    name: "Atomic User",
    twoFactorEnabled: enabled,
    username: `atomic-${userId}`,
  });
  await database!.insert(accounts).values({
    id: newId(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(password),
  });
  await database!.insert(twoFactors).values({
    id: newId(),
    userId,
    secret: "encrypted-secret",
    backupCodes: "encrypted-backup-codes",
    verified: enabled,
  });
  await database!.insert(sessions).values([
    {
      id: newId(),
      token: newId(),
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    },
    {
      id: newId(),
      token: newId(),
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  await database!.insert(verifications).values({
    id: newId(),
    identifier: `trust-device-${newId()}`,
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return userId;
}

async function state(userId: string) {
  const [user] = await database!
    .select({ enabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId));
  return {
    enabled: user?.enabled,
    factors: await database!
      .select()
      .from(twoFactors)
      .where(eq(twoFactors.userId, userId)),
    sessions: await database!
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId)),
    trust: await database!
      .select()
      .from(verifications)
      .where(eq(verifications.value, userId)),
  };
}

liveDescribe("atomic two-factor lifecycle", () => {
  beforeEach(async () => resetTestDatabase(connection!));
  afterAll(async () => connection?.end());

  it("rolls back every disable mutation boundary, then commits all revocations", async () => {
    const userId = await seed(true);
    const before = await state(userId);
    const failureSteps: TwoFactorDisableStep[] = [
      "password_verified",
      "user_disabled",
      "factor_deleted",
      "trust_deleted",
      "sessions_revoked",
    ];

    for (const failureStep of failureSteps) {
      await expect(
        changeTwoFactorStateAtomically({
          action: "disable",
          afterStep: (step) => {
            if (step === failureStep) throw new Error(`injected:${step}`);
          },
          database: database!,
          password,
          userId,
        }),
      ).rejects.toThrow(`injected:${failureStep}`);
      expect(await state(userId)).toEqual(before);
    }

    await expect(
      changeTwoFactorStateAtomically({
        action: "disable",
        database: database!,
        password,
        userId,
      }),
    ).resolves.toBe("disabled");
    expect(await state(userId)).toEqual({
      enabled: false,
      factors: [],
      sessions: [],
      trust: [],
    });
  });

  it("cancels only an unverified setup without revoking the current session", async () => {
    const userId = await seed(false);
    const before = await state(userId);

    await expect(
      changeTwoFactorStateAtomically({
        action: "cancel",
        database: database!,
        password,
        userId,
      }),
    ).resolves.toBe("cancelled");
    const after = await state(userId);
    expect(after.enabled).toBe(false);
    expect(after.factors).toEqual([]);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.trust).toEqual(before.trust);
  });

  it("atomically limits concurrent password attempts and resets after expiry", async () => {
    const userId = await seed(true);
    const now = new Date("2026-08-03T20:00:00.000Z");
    const attempt = (clientAddress = "198.51.100.0", at = now) =>
      consumePasswordAttempt({
        clientAddress,
        database: database!,
        now: at,
        operation: "two-factor-state-change",
        secret: attemptSecret,
        userId,
      });

    const concurrent = await Promise.all(
      Array.from({ length: 12 }, () => attempt()),
    );
    expect(concurrent.filter(Boolean)).toHaveLength(5);
    const storedAttempts = await database!.select().from(rateLimits);
    expect(storedAttempts).toHaveLength(1);
    expect(JSON.stringify(storedAttempts)).not.toContain(userId);
    expect(JSON.stringify(storedAttempts)).not.toContain("198.51.100.0");
    await expect(attempt()).resolves.toBe(false);
    await expect(attempt("203.0.113.0")).resolves.toBe(true);
    const otherUserId = await seed(true);
    await expect(
      consumePasswordAttempt({
        clientAddress: "198.51.100.0",
        database: database!,
        now,
        operation: "two-factor-state-change",
        secret: attemptSecret,
        userId: otherUserId,
      }),
    ).resolves.toBe(true);
    await expect(
      attempt(
        "198.51.100.0",
        new Date(
          now.getTime() +
            (TWO_FACTOR_PASSWORD_ATTEMPT_WINDOW_SECONDS + 1) * 1_000,
        ),
      ),
    ).resolves.toBe(true);
  });
});
