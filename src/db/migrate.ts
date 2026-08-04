import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { parseServerEnv } from "@/lib/env/server-schema";

export async function main(): Promise<void> {
  const env = parseServerEnv(process.env);
  const connection = postgres(env.DATABASE_URL, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = drizzle(connection, { schema });

  try {
    await migrate(database, { migrationsFolder: "drizzle" });
  } finally {
    await connection.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (invokedPath === import.meta.url) void main();
