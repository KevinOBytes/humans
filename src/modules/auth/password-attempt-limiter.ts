import "server-only";

import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { rateLimits } from "@/db/schema/auth";
import type { Database } from "@/modules/auth/bootstrap-admin";

export const TWO_FACTOR_PASSWORD_ATTEMPT_MAX = 5;
export const TWO_FACTOR_PASSWORD_ATTEMPT_WINDOW_SECONDS = 5 * 60;

export async function consumePasswordAttempt(input: {
  clientAddress: string;
  database: Database;
  now?: Date;
  operation: "two-factor-state-change";
  secret: string;
  userId: string;
}): Promise<boolean> {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const cutoff = nowSeconds - TWO_FACTOR_PASSWORD_ATTEMPT_WINDOW_SECONDS;
  const digest = createHmac("sha256", input.secret)
    .update("humans:password-attempt:v1\0", "utf8")
    .update(input.operation, "utf8")
    .update("\0", "utf8")
    .update(input.userId, "utf8")
    .update("\0", "utf8")
    .update(input.clientAddress, "utf8")
    .digest("hex");
  const key = `humans-password-attempt:${digest}`;
  const [row] = await input.database
    .insert(rateLimits)
    .values({
      id: newId(),
      key,
      count: 1,
      lastRequest: nowSeconds,
    })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql<number>`CASE WHEN ${rateLimits.lastRequest} <= ${cutoff} THEN 1 ELSE LEAST(${rateLimits.count} + 1, ${TWO_FACTOR_PASSWORD_ATTEMPT_MAX + 1}) END`,
        lastRequest: sql<number>`CASE WHEN ${rateLimits.lastRequest} <= ${cutoff} THEN ${nowSeconds} ELSE ${rateLimits.lastRequest} END`,
      },
    })
    .returning({ count: rateLimits.count });
  return Boolean(row && row.count <= TWO_FACTOR_PASSWORD_ATTEMPT_MAX);
}
