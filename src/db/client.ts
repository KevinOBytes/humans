import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/lib/env/server";
import { recordDatabaseQuery } from "@/graphql/query-instrumentation";

import * as schema from "./schema";

const serverEnv = getServerEnv();

export const databaseConnection = postgres(serverEnv.DATABASE_URL, {
  ...(serverEnv.NODE_ENV === "test" &&
  process.env.GRAPH_PERFORMANCE_TEST_RUNTIME === "1" &&
  process.env.GRAPH_PERFORMANCE_INSTRUMENTATION === "1"
    ? { debug: recordDatabaseQuery }
    : {}),
  prepare: false,
});

export const db = drizzle(databaseConnection, { schema });
