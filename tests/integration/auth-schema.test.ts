// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";

import * as databaseSchema from "@/db/schema";
import * as authSchema from "@/db/schema/auth";

const schema = authSchema as unknown as Record<string, Record<string, unknown>>;

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

const runtimeAuthSource = readFileSync(
  new URL("../../src/lib/auth/config.ts", import.meta.url),
  "utf8",
);

describe("Better Auth schema", () => {
  it("pins one compatible Better Auth package family", () => {
    expect(packageJson.dependencies["better-auth"]).toBe("1.6.25");
    expect(packageJson.dependencies["@better-auth/drizzle-adapter"]).toBe(
      "1.6.25",
    );
    expect(packageJson.dependencies["@better-auth/api-key"]).toBe("1.6.25");
    expect(packageJson.devDependencies.auth).toBe("1.6.23");
  });

  it("uses the current two-factor representation", () => {
    expect("twoFactorEnabled" in schema.users).toBe(true);
    expect("twoFactors" in schema).toBe(true);
    expect("backupCodes" in (schema.twoFactors ?? {})).toBe(true);
    expect("backupCodes" in schema).toBe(false);
  });

  it("uses the current organization-owned API-key representation", () => {
    expect("configId" in schema.apiKeys).toBe(true);
    expect("referenceId" in schema.apiKeys).toBe(true);
    expect("userId" in schema.apiKeys).toBe(false);
    expect("permissions" in schema.apiKeys).toBe(true);
    expect("metadata" in schema.apiKeys).toBe(true);
  });

  it("exposes the member workspace key needed for tenant-safe grants", () => {
    expect("workspaceId" in schema.members).toBe(true);
  });

  it("builds one extensible auth instance with every required plugin", async () => {
    const { createHumansAuth } = await import("@/lib/auth/config");
    const instance = createHumansAuth({
      database: drizzle.mock({ schema: databaseSchema }),
      emailSender: { send: async () => ({ id: "test" }) },
      settings: {
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AUTH_SECRET: "task-4-auth-schema-test-secret-value",
        AUTH_ENCRYPTION_KEY: "01".repeat(32),
        AUTH_REGISTRATION_MODE: "public",
        AUTH_SECURE_COOKIES: false,
        AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
      },
    });

    expect(instance.options.plugins?.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        "username",
        "two-factor",
        "admin",
        "organization",
        "api-key",
      ]),
    );
    const organizationPlugin = instance.options.plugins?.find(
      (plugin) => plugin.id === "organization",
    );
    const memberFields = (
      organizationPlugin as
        | {
            schema?: { member?: { fields?: Record<string, unknown> } };
          }
        | undefined
    )?.schema?.member?.fields as
      | Record<string, { input?: boolean; required?: boolean; type?: string }>
      | undefined;
    expect(memberFields?.workspaceId).toMatchObject({
      input: false,
      required: true,
      type: "string",
    });
  });

  it("emits only allowlisted security events for dependency warnings and failures", async () => {
    const { createHumansAuth } = await import("@/lib/auth/config");
    const secret = "private-better-auth-warning-material";
    const events: unknown[] = [];
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const instance = createHumansAuth({
        database: drizzle.mock({ schema: databaseSchema }),
        emailSender: { send: async () => ({ id: "test" }) },
        securityLogger: { log: (event: unknown) => events.push(event) },
        settings: {
          NEXT_PUBLIC_APP_URL: "http://localhost:3000",
          AUTH_SECRET: "task-4-auth-schema-test-secret-value",
          AUTH_ENCRYPTION_KEY: "01".repeat(32),
          AUTH_REGISTRATION_MODE: "public",
          AUTH_SECURE_COOKIES: false,
          AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
        },
      });
      const dependencyLog = instance.options.logger?.log;
      expect(dependencyLog).toBeTypeOf("function");
      dependencyLog?.(
        "warn",
        `Unsafe dependency configuration: ${secret}`,
        new Error(secret),
      );
      dependencyLog?.(
        "error",
        `failed query select '${secret}'`,
        new Error(`parameters: ${secret}`),
      );

      expect(events).toEqual([
        { event: "auth.security.warning", severity: "warn" },
        { event: "auth.infrastructure.failure", severity: "error" },
      ]);
      expect(consoleWarn.mock.calls).toEqual([]);
      expect(consoleError.mock.calls).toEqual([]);
      expect(
        JSON.stringify([
          events,
          consoleWarn.mock.calls,
          consoleError.mock.calls,
        ]),
      ).not.toContain(secret);
    } finally {
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("rejects construction without a validated runtime auth secret", async () => {
    const { createHumansAuth } = await import("@/lib/auth/config");

    expect(() =>
      createHumansAuth({
        database: drizzle.mock({ schema: databaseSchema }),
        emailSender: { send: async () => ({ id: "test" }) },
        settings: {
          NEXT_PUBLIC_APP_URL: "http://localhost:3000",
          AUTH_SECRET: undefined as never,
          AUTH_ENCRYPTION_KEY: "01".repeat(32),
          AUTH_REGISTRATION_MODE: "public",
          AUTH_SECURE_COOKIES: false,
          AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
        },
      }),
    ).toThrow(/validated AUTH_SECRET/);
  });

  it("rejects a reused auth signing and material-encryption key", async () => {
    const { createHumansAuth } = await import("@/lib/auth/config");
    const sharedKey = "01".repeat(32);

    expect(() =>
      createHumansAuth({
        database: drizzle.mock({ schema: databaseSchema }),
        emailSender: { send: async () => ({ id: "test" }) },
        settings: {
          NEXT_PUBLIC_APP_URL: "http://localhost:3000",
          AUTH_SECRET: sharedKey,
          AUTH_ENCRYPTION_KEY: sharedKey,
          AUTH_REGISTRATION_MODE: "public",
          AUTH_SECURE_COOKIES: false,
          AUTH_TRUSTED_ORIGINS: ["http://localhost:3000"],
        },
      }),
    ).toThrow(/must differ/i);
  });

  it("keeps the generation-only secret out of runtime auth exports", async () => {
    const runtimeAuth = await import("@/lib/auth/config");

    expect(runtimeAuthSource).not.toContain("generation-only-secret");
    expect(runtimeAuthSource).not.toContain("process.env.BETTER_AUTH_SECRET");
    expect("auth" in runtimeAuth).toBe(false);
    expect("default" in runtimeAuth).toBe(false);
  });

  it("loads CLI schema generation from an isolated script", () => {
    expect(packageJson.scripts?.["auth:schema:generate"]).toContain(
      "scripts/better-auth-schema.ts",
    );
    expect(packageJson.scripts?.["auth:schema:generate"]).not.toContain(
      "src/lib/auth/config.ts",
    );
    expect(packageJson.scripts?.["auth:schema:check"]).toBe(
      "tsx scripts/check-better-auth-schema.ts",
    );
  });
});
