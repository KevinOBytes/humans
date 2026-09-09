import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { parseAdminOperationEnv } from "@/lib/env/server-schema";
import { bootstrapAdmin } from "@/modules/auth/bootstrap-admin";

/**
 * Explicitly rotates the configured administrator's credential.
 *
 * This entrypoint is intentionally separate from request handling and the
 * idempotent bootstrap command. Operators must invoke it deliberately.
 */
export async function main(): Promise<void> {
  const env = parseAdminOperationEnv(process.env);
  const connection = postgres(env.DATABASE_URL, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = drizzle(connection, { schema });

  try {
    const result = await bootstrapAdmin(database, env, {
      rotatePassword: true,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await connection.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (invokedPath === import.meta.url) void main();
