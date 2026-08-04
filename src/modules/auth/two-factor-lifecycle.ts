import "server-only";

import { verifyPassword as verifyPasswordHash } from "better-auth/crypto";
import { and, eq, like } from "drizzle-orm";

import {
  accounts,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@/db/schema/auth";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type TwoFactorDisableStep =
  | "password_verified"
  | "user_disabled"
  | "factor_deleted"
  | "trust_deleted"
  | "sessions_revoked";

export class TwoFactorLifecycleError extends Error {
  override readonly name = "TwoFactorLifecycleError";

  constructor(readonly code: "CONFLICT" | "INVALID_PASSWORD" | "NOT_FOUND") {
    super("The two-step verification change could not be completed.");
  }
}

export async function changeTwoFactorStateAtomically(input: {
  action: "cancel" | "disable";
  afterStep?: (step: TwoFactorDisableStep) => void | Promise<void>;
  database: Database;
  password: string;
  userId: string;
  verifyPassword?: (input: {
    hash: string;
    password: string;
  }) => Promise<boolean>;
}): Promise<"cancelled" | "disabled"> {
  return input.database.transaction(async (transaction) => {
    const [identity] = await transaction
      .select({
        passwordHash: accounts.password,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .innerJoin(
        accounts,
        and(
          eq(accounts.userId, users.id),
          eq(accounts.providerId, "credential"),
        ),
      )
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!identity?.passwordHash) {
      throw new TwoFactorLifecycleError("NOT_FOUND");
    }
    const verify = input.verifyPassword ?? verifyPasswordHash;
    if (
      !(await verify({ hash: identity.passwordHash, password: input.password }))
    ) {
      throw new TwoFactorLifecycleError("INVALID_PASSWORD");
    }
    await input.afterStep?.("password_verified");

    if (input.action === "cancel") {
      if (identity.twoFactorEnabled === true) {
        throw new TwoFactorLifecycleError("CONFLICT");
      }
      await transaction
        .delete(twoFactors)
        .where(eq(twoFactors.userId, input.userId));
      await input.afterStep?.("factor_deleted");
      return "cancelled";
    }

    if (identity.twoFactorEnabled !== true) {
      throw new TwoFactorLifecycleError("CONFLICT");
    }
    await transaction
      .update(users)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(users.id, input.userId));
    await input.afterStep?.("user_disabled");
    await transaction
      .delete(twoFactors)
      .where(eq(twoFactors.userId, input.userId));
    await input.afterStep?.("factor_deleted");
    await transaction
      .delete(verifications)
      .where(
        and(
          eq(verifications.value, input.userId),
          like(verifications.identifier, "trust-device-%"),
        ),
      );
    await input.afterStep?.("trust_deleted");
    await transaction.delete(sessions).where(eq(sessions.userId, input.userId));
    await input.afterStep?.("sessions_revoked");
    return "disabled";
  });
}
