import { hashPassword } from "better-auth/crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { newId } from "@/db/id";
import * as schema from "@/db/schema";
import { accounts, users } from "@/db/schema/auth";
import type { BootstrapAdminEnv } from "@/lib/env/server-schema";

export type Database = PostgresJsDatabase<typeof schema>;

export type BootstrapAdminResult = {
  userId: string;
  created: boolean;
  reconciled: boolean;
};

const advisoryLockName = "humans:bootstrap-admin:v1";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Reconciles the configured deployment administrator without treating the
 * environment password as perpetual authority over a changed credential.
 */
export async function bootstrapAdmin(
  database: Database,
  env: BootstrapAdminEnv,
): Promise<BootstrapAdminResult> {
  const email = normalizeEmail(env.ADMIN_EMAIL);
  const username = normalizeUsername(env.ADMIN_USERNAME);
  const displayName = env.ADMIN_DISPLAY_NAME.trim();

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${advisoryLockName}))`,
    );

    const candidates = await transaction
      .select()
      .from(users)
      .where(
        or(
          sql`lower(${users.email}) = ${email}`,
          sql`lower(${users.username}) = ${username}`,
        ),
      );

    const emailUser = candidates.find(
      (candidate) => normalizeEmail(candidate.email) === email,
    );
    const usernameUser = candidates.find(
      (candidate) =>
        candidate.username !== null &&
        normalizeUsername(candidate.username) === username,
    );

    if (emailUser && usernameUser && emailUser.id !== usernameUser.id) {
      throw new Error("Configured administrator identity is ambiguous");
    }

    const existing = emailUser ?? usernameUser;
    if (!existing) {
      const userId = newId();
      const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
      const now = new Date();

      await transaction.insert(users).values({
        id: userId,
        name: displayName,
        email,
        emailVerified: true,
        username,
        displayUsername: username,
        role: "admin",
        createdAt: now,
        updatedAt: now,
      });
      await transaction.insert(accounts).values({
        id: newId(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });

      return { userId, created: true, reconciled: false };
    }

    const identityChanged =
      existing.email !== email ||
      existing.emailVerified !== true ||
      existing.username !== username ||
      existing.displayUsername !== username ||
      existing.name !== displayName ||
      existing.role !== "admin";

    if (identityChanged) {
      await transaction
        .update(users)
        .set({
          email,
          emailVerified: true,
          username,
          displayUsername: username,
          name: displayName,
          role: "admin",
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
    }

    const [credential] = await transaction
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, existing.id),
          eq(accounts.providerId, "credential"),
        ),
      )
      .limit(1);

    let credentialCreated = false;
    if (!credential) {
      const now = new Date();
      const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
      await transaction.insert(accounts).values({
        id: newId(),
        accountId: existing.id,
        providerId: "credential",
        userId: existing.id,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
      credentialCreated = true;
    }

    return {
      userId: existing.id,
      created: false,
      reconciled: identityChanged || credentialCreated,
    };
  });
}
