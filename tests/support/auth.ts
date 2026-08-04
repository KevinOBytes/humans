// @vitest-environment node

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

import * as schema from "@/db/schema";
import {
  parseBootstrapAdminEnv,
  parseServerEnv,
  type BootstrapAdminEnv,
  type ServerEnv,
} from "@/lib/env/server-schema";

import { assertTestDatabaseResetAllowed } from "./database-reset-guard";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export type TestDatabase = PostgresJsDatabase<typeof schema> & {
  $client: Sql;
};

export type CapturedEmail = {
  html?: string;
  subject: string;
  text?: string;
  to: string | readonly string[];
};

export class TestEmailSender {
  readonly messages: CapturedEmail[] = [];

  async send(message: CapturedEmail): Promise<{ id: string }> {
    this.messages.push(structuredClone(message));
    return { id: `mail-${this.messages.length}` };
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export function createTestConnection(
  max = 10,
  debug?: (
    connection: number,
    query: string,
    parameters: unknown[],
    paramTypes: unknown[],
  ) => void,
): Sql {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
  return postgres(testDatabaseUrl, {
    max,
    onnotice: () => undefined,
    prepare: false,
    debug,
  });
}

export function createTestDatabase(
  connection: Sql = createTestConnection(),
): TestDatabase {
  return drizzle(connection, { schema });
}

export async function resetTestDatabase(connection: Sql): Promise<void> {
  const [{ currentDatabase }] = await connection<[{ currentDatabase: string }]>`
    SELECT current_database() AS "currentDatabase"
  `;
  assertTestDatabaseResetAllowed({
    allowReset: process.env.ALLOW_TEST_DATABASE_RESET,
    currentDatabase,
    databaseUrl: testDatabaseUrl,
  });
  await connection.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await connection.unsafe("DROP SCHEMA public CASCADE");
  await connection.unsafe("CREATE SCHEMA public");
  await migrate(drizzle(connection), { migrationsFolder: "drizzle" });
}

const fixturePassword = [
  "Task6",
  "Initial",
  "Administrator",
  "Password!",
  "2026",
].join("");

const testEnvironment = {
  NODE_ENV: "test",
  DEPLOYMENT_MODE: "docker",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3106",
  DATABASE_URL:
    testDatabaseUrl ??
    "postgresql://humans_test:unused@127.0.0.1:55432/humans_auth_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  STORAGE_PROVIDER: "minio",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "humans-private",
  STORAGE_ACCESS_KEY_ID: "local-fixture",
  STORAGE_SECRET_ACCESS_KEY: "local-fixture-storage-secret",
  STORAGE_FORCE_PATH_STYLE: "true",
  STORAGE_BUCKET_PUBLIC: "false",
  AUTH_SECRET: "auth-fixture-signing-secret-0123456789abcdef0123456789abcdef",
  AUTH_SECURE_COOKIES: "false",
  AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:3106",
  AUTH_REGISTRATION_MODE: "public",
  AUTH_ENCRYPTION_KEY: "31".repeat(32),
  DATA_ENCRYPTION_KEY: "42".repeat(32),
  PROTECTED_LOOKUP_HMAC_KEY: "43".repeat(32),
  OPERATION_LIMIT_HMAC_KEY: "44".repeat(32),
  TRUSTED_PROXY_MODE: "none",
  ADMIN_EMAIL: "admin@example.test",
  ADMIN_USERNAME: "humans-admin",
  ADMIN_DISPLAY_NAME: "Humans Administrator",
  ADMIN_PASSWORD: fixturePassword,
  RESEND_API_KEY: "resend-fixture-key",
  EMAIL_FROM: "Humans <humans@example.test>",
  AI_PROVIDER: "ollama",
  AI_BASE_URL: "http://127.0.0.1:11434/v1",
  AI_MODEL: "fixture-model",
} satisfies NodeJS.ProcessEnv;

export const testAdminEnv: ServerEnv & BootstrapAdminEnv = {
  ...parseServerEnv(testEnvironment),
  ...parseBootstrapAdminEnv(testEnvironment),
};

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(cookieHeader?: string) {
    if (!cookieHeader) return;
    for (const pair of cookieHeader.split(";")) {
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      this.cookies.set(
        pair.slice(0, separator).trim(),
        pair.slice(separator + 1).trim(),
      );
    }
  }

  apply(headers: Headers): void {
    const cookie = Array.from(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    if (cookie) headers.set("cookie", cookie);
  }

  capture(response: Response): void {
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue) this.cookies.set(name, cookieValue);
      else this.cookies.delete(name);
    }
  }

  clear(): void {
    this.cookies.clear();
  }

  toString(): string {
    return Array.from(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

export type AuthRequestOptions = {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  jar?: CookieJar;
  method?: string;
};

export async function authRequest(
  handler: (request: Request) => Promise<Response>,
  path: string,
  options: AuthRequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body) {
    headers.set("content-type", "application/json");
    if (!headers.has("origin")) {
      headers.set("origin", new URL(testAdminEnv.NEXT_PUBLIC_APP_URL).origin);
    }
    if (!headers.has("sec-fetch-site"))
      headers.set("sec-fetch-site", "same-origin");
  }
  options.jar?.apply(headers);
  const response = await handler(
    new Request(new URL(path, testAdminEnv.NEXT_PUBLIC_APP_URL), {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
  options.jar?.capture(response);
  return response;
}

export async function responseJson<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}
