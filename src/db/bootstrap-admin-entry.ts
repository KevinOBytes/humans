import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import {
  parseBootstrapAdminEnv,
  parseServerEnv,
} from "@/lib/env/server-schema";
import { bootstrapAdmin } from "@/modules/auth/bootstrap-admin";

export async function main(): Promise<void> {
  const runtimeEnv = parseServerEnv(process.env);
  const bootstrapEnv = parseBootstrapAdminEnv(process.env);
  const connection = postgres(runtimeEnv.DATABASE_URL, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = drizzle(connection, { schema });

  try {
    const result = await bootstrapAdmin(database, bootstrapEnv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await connection.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (invokedPath === import.meta.url) void main();
